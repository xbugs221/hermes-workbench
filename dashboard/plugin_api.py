"""Hermes Workbench dashboard backend.

Provides workspace-scoped text editing, safe inline image previews, durable
session organization metadata, and an authenticated raw shell PTY for the
standalone Workbench plugin. HTTP routes are mounted by Hermes at
``/api/plugins/workbench``; WebSocket upgrades reuse Hermes' canonical
dashboard authentication gate.
"""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import signal
import sqlite3
import struct
import tempfile
import termios
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

router = APIRouter()

# A request-scoped override lets the Codex router reuse the exact file safety
# implementation below without changing the legacy dashboard root.
_WORKSPACE_ROOT_OVERRIDE: ContextVar[Path | None] = ContextVar(
    "workbench_workspace_root_override", default=None
)

_MAX_TEXT_BYTES = 2 * 1024 * 1024
_IMAGE_MEDIA_TYPES = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}
_ASSET_SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "Content-Disposition": "inline",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}
_RESIZE_PREFIX = "\x1b[RESIZE:"
_ORGANIZATION_STATE_DIR = ".hermes-workbench"
_ORGANIZATION_DB_NAME = "session-organization.sqlite3"
_KANBAN_SESSION_LINKS_TABLE = "kanban_session_links"
_MAX_PROFILE_LENGTH = 128
_MAX_SESSION_ID_LENGTH = 256
_MAX_DISPLAY_NAME_LENGTH = 120
_MAX_COLLECTION_LENGTH = 80
_MAX_TAGS = 8
_MAX_TAG_LENGTH = 32
_MAX_SUMMARY_LENGTH = 2000
_SENSITIVE_NAMES = frozenset(
    {
        ".env",
        ".netrc",
        ".npmrc",
        ".pypirc",
        "auth.json",
        "config.yaml",
        "credentials.json",
        "gateway_state.json",
        "id_ed25519",
        "id_rsa",
        "known_hosts",
        "nous_auth.json",
    }
)
_SENSITIVE_DIRS = frozenset({".git", ".gnupg", ".ssh", "codex-auth", "secrets"})
_SAFE_HIDDEN_NAMES = frozenset(
    {
        ".dockerignore",
        ".editorconfig",
        ".env.example",
        ".env.sample",
        ".gitattributes",
        ".github",
        ".gitignore",
        ".vscode",
    }
)
_IGNORED_TREE_DIRS = frozenset(
    {
        ".venv",
        "__pycache__",
        "audio_cache",
        "backups",
        "cache",
        "digital-hub-logs",
        "image_cache",
        "logs",
        "lsp",
        "node_modules",
        "pending_messages",
        "sandboxes",
        "spawn-trees",
        "state",
        "tmp",
        "venv",
    }
)
_IGNORED_TREE_FILES = frozenset(
    {
        "channel_directory.json",
        "context_length_cache.yaml",
        "gateway-starts.log",
        "models_dev_cache.json",
        "ollama_cloud_models_cache.json",
        "provider_models_cache.json",
    }
)
_IGNORED_TREE_SUFFIXES = (
    ".db",
    ".db-shm",
    ".db-wal",
    ".lock",
    ".pid",
    ".tmp",
)



class FileWriteBody(BaseModel):
    """Complete UTF-8 file replacement with optimistic concurrency."""

    content: str = Field(max_length=_MAX_TEXT_BYTES)
    version: str | None = None


class SessionOrganizationBody(BaseModel):
    """Complete user-owned organization metadata for one Hermes session."""

    profile: str = Field(default="default", max_length=_MAX_PROFILE_LENGTH)
    session_id: str = Field(min_length=1, max_length=_MAX_SESSION_ID_LENGTH)
    display_name: str = Field(default="", max_length=_MAX_DISPLAY_NAME_LENGTH)
    collection: str = Field(default="", max_length=_MAX_COLLECTION_LENGTH)
    tags: list[str] = Field(default_factory=list, max_length=_MAX_TAGS)
    pinned: bool = False
    summary: str = Field(default="", max_length=_MAX_SUMMARY_LENGTH)


class KanbanSessionLinkBody(BaseModel):
    """One persistent association between a Kanban task and a Hermes conversation."""

    board: str = Field(default="", max_length=64)
    task_id: str = Field(min_length=1, max_length=128)
    profile: str = Field(default="default", max_length=_MAX_PROFILE_LENGTH)
    session_id: str = Field(min_length=1, max_length=_MAX_SESSION_ID_LENGTH)


class KanbanActivityBody(BaseModel):
    """One bounded aggregate request for read-only worker log tails."""

    board: str = Field(default="", max_length=64)
    task_ids: list[str] = Field(default_factory=list, min_length=1, max_length=32)
    tail_bytes: int = Field(default=8192, ge=512, le=16384)


def _workspace_root() -> Path:
    """Resolve the single configured Workbench root for this dashboard."""

    overridden = _WORKSPACE_ROOT_OVERRIDE.get()
    if overridden is not None:
        return overridden

    configured = ""
    try:
        from hermes_cli.config import cfg_get, load_config

        configured = str(
            cfg_get(load_config(), "dashboard", "workbench", "root", default="")
            or ""
        ).strip()
    except Exception:
        configured = ""

    if configured:
        root = Path(configured).expanduser()
    elif Path("/opt/data").is_dir():
        root = Path("/opt/data")
    else:
        root = Path.cwd()
    try:
        resolved = root.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=500, detail=f"Workbench root is unavailable: {exc}")
    if not resolved.is_dir():
        raise HTTPException(status_code=500, detail="Workbench root is not a directory")
    return resolved


def _organization_db_path() -> Path:
    """Create the hidden plugin state directory and return its private SQLite path."""

    root = _workspace_root()
    state_dir = root / _ORGANIZATION_STATE_DIR
    try:
        state_dir.mkdir(mode=0o700, parents=False, exist_ok=True)
        resolved_dir = state_dir.resolve(strict=True)
        resolved_dir.relative_to(root)
        if not resolved_dir.is_dir():
            raise OSError("organization state path is not a directory")
        os.chmod(resolved_dir, 0o700)
    except (OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Workbench organization state is unavailable: {exc}")

    database = resolved_dir / _ORGANIZATION_DB_NAME
    if database.exists() and database.is_symlink():
        raise HTTPException(status_code=500, detail="Workbench organization database cannot be a symlink")
    return database


def _open_organization_db() -> sqlite3.Connection:
    """Open and initialize the small plugin-owned session organization database."""

    database = _organization_db_path()
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(database, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS session_organization (
                profile TEXT NOT NULL,
                session_id TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                collection_name TEXT NOT NULL DEFAULT '',
                tags_json TEXT NOT NULL DEFAULT '[]',
                pinned INTEGER NOT NULL DEFAULT 0,
                summary TEXT NOT NULL DEFAULT '',
                updated_at REAL NOT NULL,
                PRIMARY KEY (profile, session_id)
            )
            """
        )
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {_KANBAN_SESSION_LINKS_TABLE} (
                board TEXT NOT NULL DEFAULT '',
                task_id TEXT NOT NULL,
                profile TEXT NOT NULL,
                session_id TEXT NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (board, task_id, profile, session_id)
            )
            """
        )
        # A task owns one durable conversation. Older releases allowed several
        # rows per task; retain only the newest before installing the invariant.
        connection.execute(
            f"""
            DELETE FROM {_KANBAN_SESSION_LINKS_TABLE} AS candidate
            WHERE EXISTS (
                SELECT 1 FROM {_KANBAN_SESSION_LINKS_TABLE} AS newer
                WHERE newer.board = candidate.board
                  AND newer.task_id = candidate.task_id
                  AND (
                    newer.created_at > candidate.created_at
                    OR (newer.created_at = candidate.created_at AND newer.rowid > candidate.rowid)
                  )
            )
            """
        )
        connection.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{_KANBAN_SESSION_LINKS_TABLE}_one_per_task "
            f"ON {_KANBAN_SESSION_LINKS_TABLE} (board, task_id)"
        )
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{_KANBAN_SESSION_LINKS_TABLE}_task "
            f"ON {_KANBAN_SESSION_LINKS_TABLE} (board, task_id, created_at DESC)"
        )
        columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(session_organization)").fetchall()
        }
        if "display_name" not in columns:
            connection.execute(
                "ALTER TABLE session_organization ADD COLUMN display_name TEXT NOT NULL DEFAULT ''"
            )
        connection.commit()
        os.chmod(database, 0o600)
        return connection
    except (OSError, sqlite3.Error) as exc:
        if connection is not None:
            connection.close()
        raise HTTPException(status_code=500, detail=f"Workbench organization database failed: {exc}")


def _clean_identifier(value: str, *, label: str, maximum: int) -> str:
    """Validate one bounded profile/session identifier without rewriting its identity."""

    cleaned = str(value or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail=f"{label} is required")
    if len(cleaned) > maximum:
        raise HTTPException(status_code=400, detail=f"{label} is too long")
    if any(ord(character) < 32 for character in cleaned):
        raise HTTPException(status_code=400, detail=f"{label} contains control characters")
    return cleaned


def _clean_single_line(value: str, *, label: str, maximum: int) -> str:
    """Normalize one user-facing label to a bounded single line."""

    cleaned = " ".join(str(value or "").split())
    if len(cleaned) > maximum:
        raise HTTPException(status_code=400, detail=f"{label} is too long")
    return cleaned


def _normalize_organization(body: SessionOrganizationBody) -> dict[str, Any]:
    """Normalize display name, collection, tags and summary while preserving user wording."""

    profile = _clean_identifier(body.profile or "default", label="Profile", maximum=_MAX_PROFILE_LENGTH)
    session_id = _clean_identifier(
        body.session_id,
        label="Session ID",
        maximum=_MAX_SESSION_ID_LENGTH,
    )
    display_name = _clean_single_line(
        body.display_name,
        label="Display name",
        maximum=_MAX_DISPLAY_NAME_LENGTH,
    )
    collection = _clean_single_line(
        body.collection,
        label="Collection",
        maximum=_MAX_COLLECTION_LENGTH,
    )
    tags: list[str] = []
    seen: set[str] = set()
    for raw_tag in body.tags:
        tag = _clean_single_line(raw_tag, label="Tag", maximum=_MAX_TAG_LENGTH)
        key = tag.casefold()
        if not tag or key in seen:
            continue
        seen.add(key)
        tags.append(tag)
    if len(tags) > _MAX_TAGS:
        raise HTTPException(status_code=400, detail=f"At most {_MAX_TAGS} tags are allowed")
    summary = str(body.summary or "").replace("\r\n", "\n").strip()
    if len(summary) > _MAX_SUMMARY_LENGTH:
        raise HTTPException(status_code=400, detail="Summary is too long")
    return {
        "profile": profile,
        "session_id": session_id,
        "display_name": display_name,
        "collection": collection,
        "tags": tags,
        "pinned": bool(body.pinned),
        "summary": summary,
    }


def _organization_row(row: sqlite3.Row) -> dict[str, Any]:
    """Convert one SQLite row into the stable JSON shape consumed by Workbench."""

    try:
        tags = json.loads(row["tags_json"])
    except (json.JSONDecodeError, TypeError):
        tags = []
    return {
        "profile": str(row["profile"]),
        "session_id": str(row["session_id"]),
        "display_name": str(row["display_name"] or ""),
        "collection": str(row["collection_name"] or ""),
        "tags": [str(tag) for tag in tags if str(tag).strip()] if isinstance(tags, list) else [],
        "pinned": bool(row["pinned"]),
        "summary": str(row["summary"] or ""),
        "updated_at": float(row["updated_at"]),
    }


def _list_session_organization(profile: str) -> list[dict[str, Any]]:
    """List all plugin-owned organization rows for one Hermes profile."""

    normalized_profile = _clean_identifier(
        profile or "default",
        label="Profile",
        maximum=_MAX_PROFILE_LENGTH,
    )
    connection = _open_organization_db()
    try:
        rows = connection.execute(
            """
            SELECT profile, session_id, display_name, collection_name, tags_json, pinned, summary, updated_at
            FROM session_organization
            WHERE profile = ?
            ORDER BY pinned DESC, updated_at DESC
            """,
            (normalized_profile,),
        ).fetchall()
        return [_organization_row(row) for row in rows]
    finally:
        connection.close()


def _save_session_organization(body: SessionOrganizationBody) -> dict[str, Any]:
    """Upsert one metadata row, deleting it when every organization field is empty."""

    item = _normalize_organization(body)
    connection = _open_organization_db()
    try:
        if (
            not item["display_name"]
            and not item["collection"]
            and not item["tags"]
            and not item["pinned"]
            and not item["summary"]
        ):
            connection.execute(
                "DELETE FROM session_organization WHERE profile = ? AND session_id = ?",
                (item["profile"], item["session_id"]),
            )
            connection.commit()
            return {**item, "updated_at": 0.0, "deleted": True}

        updated_at = time.time()
        connection.execute(
            """
            INSERT INTO session_organization (
                profile, session_id, display_name, collection_name, tags_json, pinned, summary, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(profile, session_id) DO UPDATE SET
                display_name = excluded.display_name,
                collection_name = excluded.collection_name,
                tags_json = excluded.tags_json,
                pinned = excluded.pinned,
                summary = excluded.summary,
                updated_at = excluded.updated_at
            """,
            (
                item["profile"],
                item["session_id"],
                item["display_name"],
                item["collection"],
                json.dumps(item["tags"], ensure_ascii=False, separators=(",", ":")),
                int(item["pinned"]),
                item["summary"],
                updated_at,
            ),
        )
        connection.commit()
        return {**item, "updated_at": updated_at, "deleted": False}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"Could not save session organization: {exc}")
    finally:
        connection.close()


def _normalize_kanban_session_link(body: KanbanSessionLinkBody) -> dict[str, str]:
    """Validate one task/session association without trusting a filesystem path."""

    board = _clean_identifier(body.board, label="Board", maximum=64) if body.board else ""
    return {
        "board": board,
        "task_id": _clean_identifier(body.task_id, label="Task ID", maximum=128),
        "profile": _clean_identifier(body.profile or "default", label="Profile", maximum=_MAX_PROFILE_LENGTH),
        "session_id": _clean_identifier(body.session_id, label="Session ID", maximum=_MAX_SESSION_ID_LENGTH),
    }


def _save_kanban_session_link(body: KanbanSessionLinkBody) -> dict[str, Any]:
    """Persist the first Workbench conversation for a task and always reuse it."""

    item = _normalize_kanban_session_link(body)
    connection = _open_organization_db()
    try:
        created_at = time.time()
        connection.execute(
            f"""
            INSERT INTO {_KANBAN_SESSION_LINKS_TABLE} (board, task_id, profile, session_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(board, task_id) DO NOTHING
            """,
            (item["board"], item["task_id"], item["profile"], item["session_id"], created_at),
        )
        row = connection.execute(
            f"SELECT board, task_id, profile, session_id, created_at FROM {_KANBAN_SESSION_LINKS_TABLE} "
            "WHERE board = ? AND task_id = ?",
            (item["board"], item["task_id"]),
        ).fetchone()
        connection.commit()
        return dict(row) if row is not None else {**item, "created_at": created_at}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"Could not save Kanban session link: {exc}")
    finally:
        connection.close()


def _list_kanban_session_links(task_id: str, board: str = "") -> list[dict[str, Any]]:
    """Return the task's single conversation; board scope prevents collisions."""

    item = _clean_identifier(task_id, label="Task ID", maximum=128)
    normalized_board = _clean_identifier(board, label="Board", maximum=64) if board else ""
    connection = _open_organization_db()
    try:
        rows = connection.execute(
            f"SELECT board, task_id, profile, session_id, created_at FROM {_KANBAN_SESSION_LINKS_TABLE} "
            "WHERE board = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1",
            (normalized_board, item),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def _read_kanban_activity(body: KanbanActivityBody) -> dict[str, Any]:
    """Read several task logs in one call without creating sessions or PTYs."""

    board = str(body.board or "").strip().lower()
    if board and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", board) is None:
        raise HTTPException(status_code=400, detail="Invalid board slug")

    task_ids: list[str] = []
    for raw_task_id in body.task_ids:
        task_id = str(raw_task_id or "").strip()
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", task_id) is None:
            raise HTTPException(status_code=400, detail="Invalid task ID")
        if task_id not in task_ids:
            task_ids.append(task_id)

    if not board:
        board = str(os.environ.get("HERMES_KANBAN_BOARD") or "").strip().lower()
        if not board:
            home = Path(
                os.environ.get("HERMES_KANBAN_HOME")
                or os.environ.get("HERMES_HOME")
                or os.environ.get("HOME")
                or "/opt/data"
            ).expanduser()
            current = home / "kanban" / "current"
            try:
                board = current.read_text(encoding="utf-8").strip().lower()
            except OSError:
                board = "default"
    if re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", board) is None:
        raise HTTPException(status_code=400, detail="Invalid board slug")

    kanban_home = Path(
        os.environ.get("HERMES_KANBAN_HOME")
        or os.environ.get("HERMES_HOME")
        or os.environ.get("HOME")
        or "/opt/data"
    ).expanduser()
    if board == "default":
        logs = kanban_home / "kanban" / "logs"
    else:
        logs = kanban_home / "kanban" / "boards" / board / "logs"

    items: list[dict[str, str]] = []
    for task_id in task_ids:
        path = logs / f"{task_id}.log"
        try:
            with path.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - body.tail_bytes))
                content = handle.read(body.tail_bytes).decode("utf-8", errors="replace")
        except OSError:
            content = ""
        items.append({"task_id": task_id, "content": content})
    return {"board": board, "items": items}



def _hermes_state_db_path() -> Path:
    """Return the profile-local Hermes session store used for legacy link discovery."""

    home = Path(os.environ.get("HERMES_HOME") or os.environ.get("HOME") or "/opt/data").expanduser()
    return home / "state.db"


def _discover_legacy_kanban_session(task_id: str, board: str) -> dict[str, Any] | None:
    """Find the earliest explicit 'opened from Kanban' chat and persist it lazily."""

    normalized_task = _clean_identifier(task_id, label="Task ID", maximum=128)
    normalized_board = _clean_identifier(board, label="Board", maximum=64) if board else ""
    database = _hermes_state_db_path()
    if not database.is_file() or database.is_symlink():
        return None
    marker = f"我从看板打开了任务 {normalized_task}。"
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(sessions)").fetchall()}
        profile_sql = (
            "COALESCE(NULLIF(s.profile_name, ''), 'default')"
            if "profile_name" in columns
            else "'default'"
        )
        row = connection.execute(
            f"""
            SELECT s.id AS session_id, s.started_at AS started_at, {profile_sql} AS profile
            FROM sessions AS s
            JOIN messages AS m ON m.session_id = s.id
            WHERE m.role = 'user'
              AND substr(CAST(m.content AS TEXT), 1, ?) = ?
            ORDER BY s.started_at ASC, s.id ASC
            LIMIT 1
            """,
            (len(marker), marker),
        ).fetchone()
    except sqlite3.Error:
        return None
    finally:
        if connection is not None:
            connection.close()
    if row is None:
        return None
    return _save_kanban_session_link(
        KanbanSessionLinkBody(
            board=normalized_board,
            task_id=normalized_task,
            profile=str(row["profile"] or "default"),
            session_id=str(row["session_id"]),
        )
    )


def _list_or_migrate_kanban_session_links(task_id: str, board: str = "") -> list[dict[str, Any]]:
    """Return an explicit link, or lazily backfill one from pre-link Workbench chats."""

    existing = _list_kanban_session_links(task_id, board)
    if existing:
        return existing
    discovered = _discover_legacy_kanban_session(task_id, board)
    return [discovered] if discovered is not None else []


def _is_sensitive(relative: Path) -> bool:
    """Return whether a relative path may expose credentials or VCS internals."""

    lowered = [part.lower() for part in relative.parts]
    if any(part in _SENSITIVE_DIRS for part in lowered):
        return True
    if any(part.startswith(".") and part not in _SAFE_HIDDEN_NAMES for part in lowered):
        return True
    name = lowered[-1] if lowered else ""
    if name in _SENSITIVE_NAMES:
        return True
    if name in {".env.example", ".env.sample"}:
        return False
    if any(name.startswith(f"{base}.") or name.startswith(f"{base}-") for base in _SENSITIVE_NAMES):
        return True
    if name.endswith((".key", ".pem")):
        return True
    return name.startswith(".env.") and not name.endswith((".example", ".sample"))


def _hide_from_tree(relative: Path) -> bool:
    """Keep secrets and Hermes runtime artifacts out of business-file navigation."""

    lowered = [part.lower() for part in relative.parts]
    name = lowered[-1] if lowered else ""
    return (
        _is_sensitive(relative)
        or any(part in _IGNORED_TREE_DIRS for part in lowered)
        or name in _IGNORED_TREE_FILES
        or name.endswith(_IGNORED_TREE_SUFFIXES)
    )


def _resolve_path(raw_path: str | None, *, must_exist: bool = True) -> tuple[Path, Path]:
    """Resolve one user path beneath the configured root without traversal."""

    root = _workspace_root()
    text = str(raw_path or "").strip()
    candidate = Path(text)
    if candidate.is_absolute():
        unresolved = candidate
    else:
        if ".." in candidate.parts:
            raise HTTPException(status_code=400, detail="Path cannot contain '..'")
        unresolved = root / candidate
    try:
        if must_exist or unresolved.exists():
            resolved = unresolved.resolve(strict=True)
        else:
            resolved = unresolved.parent.resolve(strict=True) / unresolved.name
        relative = resolved.relative_to(root)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Path not found")
    except (OSError, RuntimeError, ValueError):
        raise HTTPException(status_code=403, detail="Path is outside the Workbench root")
    if _is_sensitive(relative):
        raise HTTPException(status_code=403, detail="Sensitive paths are not available")
    return resolved, relative


def _version(data: bytes) -> str:
    """Build the stable content version used by optimistic saves."""

    return hashlib.sha256(data).hexdigest()


def _read_text(path: Path) -> tuple[str, bytes]:
    """Read one bounded UTF-8 text file and reject binary input."""

    try:
        size = path.stat().st_size
        if size > _MAX_TEXT_BYTES:
            raise HTTPException(status_code=413, detail="File is too large to edit")
        data = path.read_bytes()
    except HTTPException:
        raise
    except PermissionError:
        raise HTTPException(status_code=403, detail="File is not readable")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not read file: {exc}")
    if b"\x00" in data:
        raise HTTPException(status_code=415, detail="Binary files cannot be edited")
    try:
        return data.decode("utf-8"), data
    except UnicodeDecodeError:
        raise HTTPException(status_code=415, detail="Only UTF-8 text files can be edited")


def _asset_media_type(path: Path) -> str:
    """Return the approved browser media type for one image preview path."""

    media_type = _IMAGE_MEDIA_TYPES.get(path.suffix.lower())
    if media_type is None:
        raise HTTPException(status_code=415, detail="Only image files can be previewed")
    return media_type


def _atomic_write(path: Path, content: str, expected_version: str | None) -> dict[str, Any]:
    """Atomically replace a text file after checking its current version."""

    encoded = content.encode("utf-8")
    if len(encoded) > _MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="File is too large to edit")
    existing_mode = 0o644
    if path.exists():
        if not path.is_file():
            raise HTTPException(status_code=400, detail="Path is not a file")
        _text, current = _read_text(path)
        current_version = _version(current)
        if expected_version is not None and expected_version != current_version:
            raise HTTPException(
                status_code=409,
                detail={"message": "File changed on disk", "version": current_version},
            )
        existing_mode = path.stat().st_mode & 0o777
    elif expected_version not in (None, ""):
        raise HTTPException(status_code=409, detail="File no longer exists")

    temporary = ""
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as handle:
            temporary = handle.name
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, existing_mode)
        os.replace(temporary, path)
        temporary = ""
    except PermissionError:
        raise HTTPException(status_code=403, detail="File is not writable")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not save file: {exc}")
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass
    return {"ok": True, "version": _version(encoded), "size": len(encoded)}


@router.get("/workspace")
async def workspace(profile: str = "default", session: str = "") -> dict[str, Any]:
    """Return the workspace bound to the selected Hermes session."""

    root = await asyncio.to_thread(_workspace_root)
    identity = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:16]
    return {
        "workspace": {
            "id": identity,
            "name": root.name or str(root),
            "path": str(root),
            "profile": profile,
            "session_id": session,
        }
    }


@router.get("/session-organization")
async def get_session_organization(profile: str = "default") -> dict[str, Any]:
    """Return collection, tag, pin and summary metadata for one profile."""

    items = await asyncio.to_thread(_list_session_organization, profile)
    return {"profile": profile or "default", "items": items}


@router.put("/session-organization")
async def put_session_organization(body: SessionOrganizationBody) -> dict[str, Any]:
    """Persist complete organization metadata for one session."""

    return await asyncio.to_thread(_save_session_organization, body)


@router.get("/kanban-sessions")
async def get_kanban_sessions(task_id: str, board: str = "") -> dict[str, Any]:
    """Return Workbench conversations explicitly associated with one Kanban task."""

    return {"items": await asyncio.to_thread(_list_or_migrate_kanban_session_links, task_id, board)}


@router.put("/kanban-sessions")
async def put_kanban_session(body: KanbanSessionLinkBody) -> dict[str, Any]:
    """Store a task-to-session association after a new Workbench chat gains its ID."""

    return {"link": await asyncio.to_thread(_save_kanban_session_link, body)}


@router.post("/kanban-activity")
async def post_kanban_activity(body: KanbanActivityBody) -> dict[str, Any]:
    """Return bounded worker log tails for several cards in one request."""

    return await asyncio.to_thread(_read_kanban_activity, body)


@router.get("/files")
async def list_files(path: str = Query(default="")) -> dict[str, Any]:
    """List direct children of one workspace directory."""

    target, relative = await asyncio.to_thread(_resolve_path, path)
    root = await asyncio.to_thread(_workspace_root)
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    def _scan() -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        try:
            children = sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
        except PermissionError:
            raise HTTPException(status_code=403, detail="Directory is not readable")
        for child in children:
            try:
                resolved = child.resolve(strict=True)
                child_relative = resolved.relative_to(root)
            except (OSError, RuntimeError, ValueError):
                continue
            if _hide_from_tree(child_relative):
                continue
            try:
                stat = resolved.stat()
            except OSError:
                continue
            entries.append(
                {
                    "name": child.name,
                    "path": child_relative.as_posix(),
                    "type": "directory" if resolved.is_dir() else "file",
                    "size": None if resolved.is_dir() else stat.st_size,
                    "mtime": stat.st_mtime,
                }
            )
        return entries

    return {"path": relative.as_posix(), "entries": await asyncio.to_thread(_scan)}


@router.get("/file")
async def get_file(path: str) -> dict[str, Any]:
    """Return one editable UTF-8 file and its content version."""

    target, relative = await asyncio.to_thread(_resolve_path, path)
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    text, data = await asyncio.to_thread(_read_text, target)
    return {
        "path": relative.as_posix(),
        "name": target.name,
        "content": text,
        "version": _version(data),
        "size": len(data),
        "mtime": target.stat().st_mtime,
    }


@router.get("/asset")
async def get_asset(path: str = Query(...)) -> FileResponse:
    """Serve one approved workspace image inline without exposing other files."""

    target, _relative = await asyncio.to_thread(_resolve_path, path)
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    media_type = _asset_media_type(target)
    return FileResponse(
        path=target,
        media_type=media_type,
        headers=_ASSET_SECURITY_HEADERS.copy(),
    )


@router.put("/file")
async def put_file(body: FileWriteBody, path: str) -> dict[str, Any]:
    """Save one UTF-8 file without overwriting unseen external changes."""

    target, relative = await asyncio.to_thread(_resolve_path, path, must_exist=False)
    if not target.parent.is_dir():
        raise HTTPException(status_code=400, detail="Parent directory does not exist")
    result = await asyncio.to_thread(_atomic_write, target, body.content, body.version)
    return {**result, "path": relative.as_posix(), "mtime": target.stat().st_mtime}


def _parse_resize_message(text: str) -> tuple[int, int] | None:
    """Parse JSON or Hermes-compatible CSI terminal resize messages."""

    cols: Any = None
    rows: Any = None
    if text.startswith(_RESIZE_PREFIX) and text.endswith("]"):
        payload = text[len(_RESIZE_PREFIX) : -1]
        try:
            cols, rows = payload.split(";", 1)
        except ValueError:
            return None
    elif text.startswith("{"):
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return None
        if payload.get("type") != "resize":
            return None
        cols, rows = payload.get("cols"), payload.get("rows")
    else:
        return None
    try:
        width = max(20, min(500, int(cols)))
        height = max(5, min(200, int(rows)))
    except (TypeError, ValueError):
        return None
    return width, height


def _resize_pty(master_fd: int, cols: int, rows: int) -> None:
    """Apply browser terminal dimensions to the shell PTY."""

    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _read_pty(master_fd: int) -> bytes | None:
    """Read one PTY chunk without permanently occupying an async worker."""

    readable, _, _ = select.select([master_fd], [], [], 0.2)
    if not readable:
        return b""
    try:
        return os.read(master_fd, 65536)
    except OSError:
        return None


def _ws_authorized(websocket: WebSocket) -> bool:
    """Accept the sidecar gate or delegate authentication to Hermes itself."""

    state = websocket.scope.get("state", {})
    if isinstance(state, dict) and state.get("workbench_authenticated") is True:
        return True

    try:
        from hermes_cli import web_server

        return bool(web_server._ws_auth_ok(websocket))
    except Exception:
        return False


def _spawn_shell(root: Path) -> tuple[int, int]:
    """Spawn the user's raw shell inside the Hermes runtime container."""

    pid, master_fd = pty.fork()
    if pid == 0:  # pragma: no cover - child is replaced by exec immediately
        os.chdir(root)
        env = os.environ.copy()
        env["PWD"] = str(root)
        env.setdefault("TERM", "xterm-256color")
        shell = env.get("SHELL") or "/bin/sh"
        if not Path(shell).is_file():
            shell = "/bin/sh"
        os.execvpe(shell, [shell, "-l"], env)
    return pid, master_fd


def _close_shell(pid: int, master_fd: int) -> None:
    """Close a shell PTY and reap the complete child process group."""

    try:
        os.close(master_fd)
    except OSError:
        pass
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            break
        except (PermissionError, OSError):
            try:
                os.kill(pid, sig)
            except OSError:
                break
        try:
            waited, _status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                return
        except (ChildProcessError, OSError):
            return
        time.sleep(0.05)
    try:
        os.waitpid(pid, 0)
    except (ChildProcessError, OSError):
        pass


def _write_pty(master_fd: int, data: bytes) -> None:
    """Write complete input bytes even when a PTY performs a short write."""

    remaining = memoryview(data)
    while remaining:
        try:
            written = os.write(master_fd, remaining)
            remaining = remaining[written:]
        except BlockingIOError:
            select.select([], [master_fd], [], 0.2)


@router.websocket("/shell")
async def shell_socket(websocket: WebSocket) -> None:
    """Bridge an authenticated browser xterm to a raw container shell PTY."""

    if not _ws_authorized(websocket):
        await websocket.close(code=4401, reason="Unauthorized")
        return
    await websocket.accept()
    pid = -1
    master_fd = -1
    try:
        root = await asyncio.to_thread(_workspace_root)
        pid, master_fd = await asyncio.to_thread(_spawn_shell, root)

        async def _pump_output() -> None:
            """Forward PTY output until the child exits or the socket closes."""

            while True:
                chunk = await asyncio.to_thread(_read_pty, master_fd)
                if chunk is None:
                    return
                if not chunk:
                    await asyncio.sleep(0)
                    continue
                await websocket.send_bytes(chunk)

        async def _pump_input() -> None:
            """Forward browser input and consume resize control frames."""

            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    return
                raw = message.get("bytes")
                text = message.get("text")
                if raw is not None:
                    await asyncio.to_thread(_write_pty, master_fd, raw)
                    continue
                if not isinstance(text, str) or not text:
                    continue
                dimensions = _parse_resize_message(text)
                if dimensions is not None:
                    await asyncio.to_thread(_resize_pty, master_fd, *dimensions)
                else:
                    await asyncio.to_thread(_write_pty, master_fd, text.encode("utf-8"))

        output_task = asyncio.create_task(_pump_output())
        input_task = asyncio.create_task(_pump_input())
        done, pending = await asyncio.wait(
            {output_task, input_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            await task
    except WebSocketDisconnect:
        pass
    finally:
        if pid > 0 and master_fd >= 0:
            await asyncio.to_thread(_close_shell, pid, master_fd)
