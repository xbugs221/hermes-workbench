"""Store and resolve Workbench Codex attachments for one session.

The browser receives only opaque attachment ids.  This module keeps the
identity and session mapping in a private manifest below the selected
workspace, writes uploads with exclusive file creation, and turns ids into
the small set of local Codex input records supported by the app server.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import stat
import threading
import unicodedata
import uuid
from pathlib import Path
from typing import Any, BinaryIO, Protocol

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
"""Default maximum encoded bytes accepted for one attachment."""

DEFAULT_MAX_ATTACHMENTS = 10
"""Default maximum number of attachments accepted in one submitted message."""

_ATTACHMENT_DIRECTORY = ".workbench-attachments"
_MANIFEST_NAME = ".manifest.json"
_CHUNK_BYTES = 1024 * 1024
_MAX_FILENAME_BYTES = 200
_ATTACHMENT_ID = re.compile(r"^[0-9a-f]{32}$")
_SCOPE_HASH = hashlib.sha256
_MAX_BYTES_ENV_NAMES = (
    "HERMES_WORKBENCH_CODEX_ATTACHMENT_MAX_BYTES",
    "HERMES_WORKBENCH_CODEX_MAX_ATTACHMENT_BYTES",
    "HERMES_WORKBENCH_CODEX_MAX_FILE_BYTES",
    "HERMES_WORKBENCH_ATTACHMENT_MAX_BYTES",
)
_MAX_FILES_ENV_NAMES = (
    "HERMES_WORKBENCH_CODEX_ATTACHMENT_MAX_FILES",
    "HERMES_WORKBENCH_CODEX_MAX_ATTACHMENTS",
    "HERMES_WORKBENCH_CODEX_MAX_FILES",
    "HERMES_WORKBENCH_ATTACHMENT_MAX_FILES",
)


class UploadLike(Protocol):
    """Subset of FastAPI's upload object used by the streaming writer."""

    filename: str | None
    content_type: str | None
    file: BinaryIO


def _configured_limit(
    names: tuple[str, ...], default: int, label: str, override: int | None
) -> int:
    """Read one positive integer limit from an explicit override or environment."""

    if override is not None:
        value = override
    else:
        value = default
        for name in names:
            raw = os.environ.get(name)
            if raw is None or not raw.strip():
                continue
            try:
                value = int(raw)
            except ValueError as exc:
                raise HTTPException(status_code=500, detail=f"Invalid {label} configuration") from exc
            break
    if value < 1:
        raise HTTPException(status_code=500, detail=f"Invalid {label} configuration")
    return value


def _max_attachment_bytes(override: int | None = None) -> int:
    """Return the configured byte limit for one upload."""

    return _configured_limit(
        _MAX_BYTES_ENV_NAMES,
        DEFAULT_MAX_ATTACHMENT_BYTES,
        "attachment byte limit",
        override,
    )


def _max_attachments(override: int | None = None) -> int:
    """Return the configured per-message attachment count limit."""

    return _configured_limit(
        _MAX_FILES_ENV_NAMES,
        DEFAULT_MAX_ATTACHMENTS,
        "attachment count limit",
        override,
    )


def sanitize_filename(raw_name: str | None) -> str:
    """Reduce an upload name to one bounded, non-control filename component."""

    name = str(raw_name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = unicodedata.normalize("NFKC", name)
    name = "".join(
        character
        for character in name
        if ord(character) >= 32 and ord(character) != 127 and character not in {"/", "\\", ":"}
    ).strip(" .")
    if not name or name in {".", ".."}:
        name = "attachment"
    encoded = name.encode("utf-8")
    if len(encoded) > _MAX_FILENAME_BYTES:
        name = encoded[:_MAX_FILENAME_BYTES].decode("utf-8", errors="ignore").rstrip(" .")
    return name or "attachment"


def detect_raster_mime(path: Path) -> str | None:
    """Return a supported raster MIME type only when the file magic agrees."""

    try:
        with path.open("rb") as stream:
            header = stream.read(12)
    except OSError:
        return None
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def _scope_key(user: str, profile: str, session_id: str) -> str:
    """Hash identity and session values without putting them in a filesystem path."""

    raw = f"{user}\x00{profile}\x00{session_id}".encode()
    return _SCOPE_HASH(raw).hexdigest()


def _contained(path: Path, root: Path) -> Path:
    """Resolve a path and require it to remain below the selected workspace."""

    try:
        resolved = path.resolve(strict=False)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail="Attachment storage is outside the session workspace") from exc
    return resolved


def _directory(path: Path, root: Path, *, create: bool) -> Path | None:
    """Validate one storage directory and optionally create it without accepting symlinks."""

    _contained(path, root)
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        if not create:
            return None
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            mode = os.lstat(path).st_mode
        else:
            mode = os.lstat(path).st_mode
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Attachment storage is unavailable") from exc
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        raise HTTPException(status_code=500, detail="Attachment storage directory is invalid")
    return path


def _scope_directory(
    root: Path, user: str, profile: str, session_id: str, *, create: bool
) -> Path | None:
    """Return the private identity/session directory under one workspace."""

    try:
        workspace = root.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=404, detail="Codex session workspace is unavailable") from exc
    if not workspace.is_dir():
        raise HTTPException(status_code=404, detail="Codex session workspace is unavailable")
    attachment_root = workspace / _ATTACHMENT_DIRECTORY
    if _directory(attachment_root, workspace, create=create) is None:
        return None
    scope = attachment_root / _scope_key(user, profile, session_id)
    return _directory(scope, workspace, create=create)


def _manifest_path(scope: Path) -> Path:
    """Return the manifest path after rejecting a pre-existing symlink."""

    target = scope / _MANIFEST_NAME
    try:
        mode = os.lstat(target).st_mode
    except FileNotFoundError:
        return target
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Attachment metadata is unavailable") from exc
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        raise HTTPException(status_code=500, detail="Attachment metadata is invalid")
    return target


def _read_manifest(scope: Path) -> dict[str, dict[str, Any]]:
    """Read and validate the server-owned attachment records for one scope."""

    target = _manifest_path(scope)
    if not target.exists():
        return {}
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="Attachment metadata is unavailable") from exc
    rows = payload.get("attachments") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise HTTPException(status_code=500, detail="Attachment metadata is invalid")
    records: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise HTTPException(status_code=500, detail="Attachment metadata is invalid")
        identifier = row.get("id")
        if not isinstance(identifier, str) or not _ATTACHMENT_ID.fullmatch(identifier):
            raise HTTPException(status_code=500, detail="Attachment metadata is invalid")
        if identifier in records:
            raise HTTPException(status_code=500, detail="Attachment metadata is invalid")
        records[identifier] = row
    return records


def _write_manifest(scope: Path, records: dict[str, dict[str, Any]]) -> None:
    """Atomically replace the scope manifest with the supplied records."""

    target = _manifest_path(scope)
    temporary = scope / f".{_MANIFEST_NAME}.{uuid.uuid4().hex}.tmp"
    payload = {"version": 1, "attachments": list(records.values())}
    descriptor: int | None = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = None
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Attachment metadata could not be saved") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def _remove_partial(directory: Path, target: Path) -> None:
    """Remove an incomplete upload and its now-empty unique directory."""

    try:
        target.unlink(missing_ok=True)
    except OSError:
        pass
    try:
        directory.rmdir()
    except OSError:
        pass


def _safe_record_path(scope: Path, identifier: str, record: dict[str, Any]) -> Path | None:
    """Resolve one manifest path while rejecting traversal, links, and replacement files."""

    name = record.get("name")
    relative_value = record.get("path")
    if not isinstance(name, str) or not isinstance(relative_value, str):
        return None
    relative = Path(relative_value)
    if (
        relative.is_absolute()
        or len(relative.parts) != 2
        or relative.parts[0] != identifier
        or relative.parts[1] != name
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        return None
    directory = scope / identifier
    target = directory / name
    try:
        for component in (directory, target):
            mode = os.lstat(component).st_mode
            if stat.S_ISLNK(mode):
                return None
        resolved_scope = scope.resolve(strict=True)
        resolved = target.resolve(strict=True)
        resolved.relative_to(resolved_scope)
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return None
    return resolved if resolved.is_file() else None


class AttachmentStore:
    """Persist and resolve opaque files for authenticated Codex sessions."""

    def __init__(
        self,
        *,
        max_bytes: int | None = None,
        max_files: int | None = None,
    ) -> None:
        """Create a store with optional test or deployment-specific limits."""

        self.max_bytes = max_bytes
        self.max_files = max_files
        self._lock_guard = threading.Lock()
        self._scope_locks: dict[str, threading.RLock] = {}

    def _lock_for(self, scope: Path) -> threading.RLock:
        """Return the process-local lock protecting one manifest."""

        key = str(scope)
        with self._lock_guard:
            return self._scope_locks.setdefault(key, threading.RLock())

    def _save_upload_sync(
        self,
        root: Path,
        user: str,
        profile: str,
        session_id: str,
        upload: UploadLike,
    ) -> dict[str, Any]:
        """Stream one upload to exclusive storage and publish its metadata last."""

        name = sanitize_filename(upload.filename)
        declared_mime = str(upload.content_type or "application/octet-stream").strip().lower()
        if not declared_mime or len(declared_mime) > 200 or any(ord(char) < 32 for char in declared_mime):
            declared_mime = "application/octet-stream"
        scope = _scope_directory(root, user, profile, session_id, create=True)
        if scope is None:  # pragma: no cover - create=True always returns a directory
            raise HTTPException(status_code=500, detail="Attachment storage is unavailable")
        with self._lock_for(scope):
            records = _read_manifest(scope)
            identifier = uuid.uuid4().hex
            directory = scope / identifier
            try:
                directory.mkdir(mode=0o700, exist_ok=False)
                mode = os.lstat(directory).st_mode
                if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                    raise OSError("attachment directory is invalid")
                target = directory / name
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                descriptor = os.open(target, flags, 0o600)
                total = 0
                try:
                    with os.fdopen(descriptor, "wb") as output:
                        descriptor = -1
                        while True:
                            chunk = upload.file.read(_CHUNK_BYTES)
                            if not chunk:
                                break
                            if not isinstance(chunk, bytes):
                                chunk = bytes(chunk)
                            total += len(chunk)
                            if total > _max_attachment_bytes(self.max_bytes):
                                raise HTTPException(status_code=413, detail="Attachment size limit exceeded")
                            output.write(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
                record = {
                    "id": identifier,
                    "name": name,
                    "size": total,
                    "mimeType": declared_mime,
                    "path": f"{identifier}/{name}",
                }
                records[identifier] = record
                _write_manifest(scope, records)
            except Exception:
                _remove_partial(directory, directory / name)
                raise
        return {key: record[key] for key in ("id", "name", "size", "mimeType")}

    async def save_upload(
        self,
        root: Path,
        user: str,
        profile: str,
        session_id: str,
        upload: UploadLike,
    ) -> dict[str, Any]:
        """Stream an upload in a worker thread so large files do not block ASGI."""

        return await asyncio.to_thread(
            self._save_upload_sync,
            root,
            user,
            profile,
            session_id,
            upload,
        )

    def resolve_inputs(
        self,
        root: Path,
        user: str,
        profile: str,
        session_id: str,
        attachment_ids: Any,
    ) -> list[dict[str, str]]:
        """Resolve only this session's ids into verified local Codex input records."""

        if attachment_ids is None:
            return []
        if not isinstance(attachment_ids, list):
            raise HTTPException(status_code=400, detail="attachmentIds must be a list")
        if not attachment_ids:
            return []
        if len(attachment_ids) > _max_attachments(self.max_files):
            raise HTTPException(status_code=400, detail="Attachment count limit exceeded")
        for identifier in attachment_ids:
            if not isinstance(identifier, str) or not _ATTACHMENT_ID.fullmatch(identifier):
                raise HTTPException(status_code=400, detail="Invalid attachment id")
        if len(set(attachment_ids)) != len(attachment_ids):
            raise HTTPException(status_code=400, detail="attachmentIds must be unique")
        scope = _scope_directory(root, user, profile, session_id, create=False)
        if scope is None:
            raise HTTPException(status_code=404, detail="Attachment not found")
        with self._lock_for(scope):
            records = _read_manifest(scope)
            result: list[dict[str, str]] = []
            for identifier in attachment_ids:
                record = records.get(identifier)
                if record is None:
                    raise HTTPException(status_code=404, detail="Attachment not found")
                target = _safe_record_path(scope, identifier, record)
                if target is None:
                    raise HTTPException(status_code=404, detail="Attachment is unavailable")
                raster_mime = detect_raster_mime(target)
                if raster_mime is not None:
                    result.append({"type": "localImage", "path": str(target)})
                else:
                    result.append(
                        {
                            "type": "text",
                            "text": f"用户附件：{record['name']}\n路径：{target}",
                        }
                    )
            return result


def create_router(bridge: Any) -> APIRouter:
    """Build the authenticated multipart attachment endpoint for one bridge."""

    from codex_bridge import _safe, _user
    from codex_files import _session_workspace

    router = APIRouter()

    @router.post("/attachments")
    async def upload_attachment(
        request: Request,
        file: UploadFile = File(...),  # noqa: B008
        profile: str = "default",
        session_id: str = "",
    ) -> dict[str, Any]:
        """Store one multipart file under the authenticated session workspace."""

        user = _user(request)
        checked_profile = _safe(profile, "profile")
        checked_session = _safe(session_id, "session")
        root = await _session_workspace(bridge, request, checked_profile, checked_session)
        store = getattr(bridge, "attachments", None)
        if not isinstance(store, AttachmentStore):
            raise HTTPException(status_code=503, detail="Codex attachment storage is unavailable")
        attachment = await store.save_upload(root, user, checked_profile, checked_session, file)
        return {"attachment": attachment}

    return router


__all__ = [
    "DEFAULT_MAX_ATTACHMENTS",
    "DEFAULT_MAX_ATTACHMENT_BYTES",
    "AttachmentStore",
    "create_router",
    "detect_raster_mime",
    "sanitize_filename",
]
