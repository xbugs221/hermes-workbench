"""Project completed Codex history into one isolated Hermes profile.

This module is the local bridge used by the Codex completion hook.  It owns no
Hermes runtime in the completion path.  A completion is projected with
Hermes' ``CodexEventProjector`` and committed together with an idempotency
mark, a learning todo, and a review outbox entry.  A later, profile-aware
worker may consume the outbox in an isolated child process after the user has
enabled that integration.
"""

from __future__ import annotations

import copy
import hashlib
import importlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple


class HermesDependencyUnavailable(RuntimeError):
    """Describe a missing or incompatible local Hermes source installation."""


def _validate_arguments(
    profile_home: object,
    hermes_session_id: object,
    cwd: object,
    thread: object,
) -> Tuple[Path, str, str, Mapping[str, Any]]:
    """Validate caller-owned identity and return normalized import arguments.

    ``profile_home`` is deliberately required.  The bridge never resolves a
    missing profile to ``HOME`` or to Hermes' default profile because that
    would allow a completion from one identity to enter another identity's
    durable history.
    """

    if not isinstance(profile_home, (str, os.PathLike)) or not str(profile_home).strip():
        raise ValueError("profile_home must be an explicit non-empty path")
    profile_text = os.fspath(profile_home)
    if profile_text in {"~", "~/", "."}:
        raise ValueError("profile_home must identify the caller-validated profile")
    profile = Path(profile_text).expanduser().resolve()
    if not isinstance(hermes_session_id, str) or not hermes_session_id.strip():
        raise ValueError("hermes_session_id must be an explicit non-empty id")
    if not isinstance(cwd, (str, os.PathLike)) or not str(cwd).strip():
        raise ValueError("cwd must be an explicit non-empty path")
    if not isinstance(thread, Mapping):
        raise ValueError("thread must be a mapping")
    return profile, hermes_session_id.strip(), os.fspath(cwd), thread


def _thread_id(thread: Mapping[str, Any]) -> str:
    """Read a Codex thread id from the supported app-server field spellings."""

    value = thread.get("id") or thread.get("thread_id") or thread.get("threadId")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("thread must contain an explicit id")
    return value.strip()


def _turn_id(turn: Mapping[str, Any], thread_id: str, index: int) -> str:
    """Read a turn id, using a deterministic local key only for malformed legacy exports."""

    value = turn.get("id") or turn.get("turn_id") or turn.get("turnId")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return f"{thread_id}:turn:{index}"


def _turns(thread: Mapping[str, Any]) -> List[Mapping[str, Any]]:
    """Return object-shaped turns from a completed Codex thread export."""

    turns = thread.get("turns")
    if turns is None and thread.get("items") is not None:
        turns = [{
            "id": thread.get("turnId") or thread.get("id"),
            "status": thread.get("status"),
            "items": thread.get("items"),
        }]
    if not isinstance(turns, Sequence) or isinstance(turns, (str, bytes, bytearray)):
        raise ValueError("thread.turns must be a list")
    if any(not isinstance(turn, Mapping) for turn in turns):
        raise ValueError("thread.turns must contain only objects")
    return list(turns)


def _load_hermes_components() -> Tuple[type, type]:
    """Load ``SessionDB`` and the projector from ``HERMES_SOURCE`` or imports.

    Import errors are raised with an operator-actionable message.  In
    particular this function does not substitute an in-memory learning store
    when Hermes cannot be imported.
    """

    source_text = os.environ.get("HERMES_SOURCE", "").strip()
    source: Optional[Path] = None
    if source_text:
        source = Path(source_text).expanduser().resolve()
        if not source.is_dir() or not (source / "hermes_state.py").is_file():
            raise HermesDependencyUnavailable(
                f"HERMES_SOURCE is not a Hermes source root: {source}"
            )
        source_string = str(source)
        if source_string not in sys.path:
            sys.path.insert(0, source_string)

    try:
        state = importlib.import_module("hermes_state")
        projector_module = importlib.import_module("agent.transports.codex_event_projector")
        session_db = getattr(state, "SessionDB")
        projector = getattr(projector_module, "CodexEventProjector")
    except (ImportError, AttributeError) as exc:
        hint = (
            f"; install Hermes dependencies or set HERMES_SOURCE={source}"
            if source
            else "; install Hermes dependencies or set HERMES_SOURCE"
        )
        raise HermesDependencyUnavailable(f"Hermes import unavailable{hint}: {exc}") from exc

    if source is not None:
        module_files = [getattr(state, "__file__", ""), getattr(projector_module, "__file__", "")]
        if any(not _path_is_under(Path(path), source) for path in module_files if path):
            raise HermesDependencyUnavailable(
                f"loaded Hermes modules do not belong to requested HERMES_SOURCE: {source}"
            )
    return session_db, projector


def _path_is_under(path: Path, root: Path) -> bool:
    """Return whether an imported module path belongs to the selected source root."""

    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _json_text(value: Any) -> str:
    """Encode outbox values without allowing arbitrary Python objects through."""

    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _ensure_outbox_schema(conn: sqlite3.Connection) -> None:
    """Create the bridge's durable tables inside the import transaction."""

    statements = (
        """
        CREATE TABLE IF NOT EXISTS codex_hermes_imports (
            hermes_session_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status = 'completed'),
            cwd TEXT NOT NULL,
            projected_messages INTEGER NOT NULL,
            tool_iterations INTEGER NOT NULL,
            imported_at REAL NOT NULL,
            PRIMARY KEY (hermes_session_id, thread_id, turn_id)
        );
        CREATE TABLE IF NOT EXISTS codex_hermes_review_outbox (
            id TEXT PRIMARY KEY,
            hermes_session_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            profile_home TEXT NOT NULL,
            cwd TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed')),
            learning_status TEXT NOT NULL CHECK (learning_status IN ('pending_review', 'completed', 'failed')),
            learning_changed INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            worker_token TEXT,
            lease_until REAL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE (hermes_session_id, thread_id)
        );
        CREATE TABLE IF NOT EXISTS codex_hermes_learning_todos (
            id TEXT PRIMARY KEY,
            hermes_session_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            profile_home TEXT NOT NULL,
            title TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending_review', 'completed', 'failed')),
            outbox_id TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE (hermes_session_id, thread_id)
        );
        CREATE INDEX IF NOT EXISTS idx_codex_hermes_imports_thread
            ON codex_hermes_imports (thread_id, turn_id);
        CREATE INDEX IF NOT EXISTS idx_codex_hermes_review_pending
            ON codex_hermes_review_outbox (state, updated_at);
        """,
    )
    # ``executescript`` issues an implicit COMMIT on sqlite3 connections.  Each
    # statement therefore uses ``execute`` so DDL and data changes remain in
    # the SessionDB writer's single transaction.
    for statement in statements[0].split(";\n"):
        if statement.strip():
            conn.execute(statement)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(codex_hermes_review_outbox)")}
    if "attempts" not in columns:
        conn.execute("ALTER TABLE codex_hermes_review_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
    if "last_error" not in columns:
        conn.execute("ALTER TABLE codex_hermes_review_outbox ADD COLUMN last_error TEXT")
    if "learning_changed" not in columns:
        conn.execute("ALTER TABLE codex_hermes_review_outbox ADD COLUMN learning_changed INTEGER NOT NULL DEFAULT 0")
    if "worker_token" not in columns:
        conn.execute("ALTER TABLE codex_hermes_review_outbox ADD COLUMN worker_token TEXT")
    if "lease_until" not in columns:
        conn.execute("ALTER TABLE codex_hermes_review_outbox ADD COLUMN lease_until REAL")


def _decode_message_row(db: Any, row: Mapping[str, Any]) -> Dict[str, Any]:
    """Convert a Hermes SQLite row into a model-shaped review snapshot entry."""

    content = row.get("content")
    decode = getattr(db, "_decode_content", None)
    if callable(decode):
        content = decode(content)
    message: Dict[str, Any] = {"role": row.get("role", "unknown"), "content": content}
    for key in (
        "tool_call_id", "tool_name", "reasoning", "reasoning_content", "finish_reason",
        "timestamp", "display_kind", "display_metadata",
    ):
        if row.get(key) is not None:
            message[key] = row[key]
    calls = row.get("tool_calls")
    if isinstance(calls, str):
        try:
            calls = json.loads(calls)
        except (TypeError, json.JSONDecodeError):
            calls = None
    if calls:
        message["tool_calls"] = calls
    return message


def _snapshot_rows(db: Any, conn: sqlite3.Connection, session_id: str) -> List[Dict[str, Any]]:
    """Read the committed active transcript from the transaction's connection."""

    rows = conn.execute(
        "SELECT * FROM messages WHERE session_id = ? AND active = 1 ORDER BY id ASC",
        (session_id,),
    ).fetchall()
    return [_decode_message_row(db, dict(row)) for row in rows]


def _review_id(session_id: str, thread_id: str) -> str:
    """Return a stable opaque outbox id for one Hermes session and Codex thread."""

    digest = hashlib.sha256(f"{session_id}\0{thread_id}".encode("utf-8")).hexdigest()[:24]
    return f"codex-review-{digest}"


def _project_turns(
    projector_type: type,
    thread_id: str,
    thread: Mapping[str, Any],
) -> Tuple[List[Dict[str, Any]], List[Tuple[str, int, int]], List[str]]:
    """Project completed turns and return messages, counts, and skipped ids."""

    messages: List[Dict[str, Any]] = []
    counts: List[Tuple[str, int, int]] = []
    skipped: List[str] = []
    for index, turn in enumerate(_turns(thread)):
        turn_id = _turn_id(turn, thread_id, index)
        if turn.get("status") != "completed":
            skipped.append(turn_id)
            continue
        projector = projector_type()
        turn_messages: List[Dict[str, Any]] = []
        tool_iterations = 0
        items = turn.get("items") or []
        if not isinstance(items, Sequence) or isinstance(items, (str, bytes, bytearray)):
            raise ValueError(f"turn {turn_id!r} items must be a list")
        for item in items:
            if not isinstance(item, Mapping):
                raise ValueError(f"turn {turn_id!r} contains a non-object item")
            result = projector.project({"method": "item/completed", "params": {"item": dict(item)}})
            projected_item = copy.deepcopy(result.messages)
            if item.get("type") == "commandExecution":
                _mark_codex_terminal(projected_item)
            turn_messages.extend(projected_item)
            tool_iterations += int(bool(result.is_tool_iteration))
        messages.extend(turn_messages)
        counts.append((turn_id, len(turn_messages), tool_iterations))
    return messages, counts, skipped


def _mark_codex_terminal(messages: List[Dict[str, Any]]) -> None:
    """Label projected command executions for Hermes' terminal achievement metric.

    Hermes' native Codex projector deliberately emits ``exec_command`` because
    that name is part of its live tool event and replay contract.  Imported
    Codex history is an archive, so the bridge can add the source-specific
    ``codex_terminal`` alias used by the achievements scanner while retaining
    the original function name and JSON arguments in ``codex_tool_name`` and
    ``function.arguments``.  Other projected tool kinds are left unchanged.
    """

    for message in messages:
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            if not isinstance(function, dict) or function.get("name") != "exec_command":
                continue
            call["codex_tool_name"] = function["name"]
            function["name"] = "codex_terminal"


def import_completed(
    profile_home: object,
    hermes_session_id: object,
    cwd: object,
    thread: object,
) -> Dict[str, Any]:
    """Import completed Codex turns into Hermes and enqueue explicit learning.

    The return value is a small hook-facing status record.  ``learning_status``
    remains ``pending_review`` until an independently controlled reviewer
    consumes the outbox; this function never claims that learning happened.
    ``dependency_unavailable`` is returned when Hermes cannot be loaded, so a
    caller can surface setup failure without creating fake history or todo
    completion.
    """

    profile, session_id, working_directory, thread_map = _validate_arguments(
        profile_home, hermes_session_id, cwd, thread
    )
    thread_id = _thread_id(thread_map)
    try:
        session_db_type, projector_type = _load_hermes_components()
    except HermesDependencyUnavailable as exc:
        return {
            "status": "dependency_unavailable",
            "learning_status": "blocked",
            "profile_home": str(profile),
            "hermes_session_id": session_id,
            "thread_id": thread_id,
            "error": str(exc),
        }

    projected, counts, skipped = _project_turns(projector_type, thread_id, thread_map)
    db_path = profile / "state.db"
    db = session_db_type(db_path=db_path)
    try:
        ensure = getattr(db, "ensure_session", None) or getattr(db, "create_session", None)
        if not callable(ensure):
            raise HermesDependencyUnavailable("Hermes SessionDB has no session creation method")
        ensure(session_id, source="codex", cwd=working_directory)

        def commit(conn: sqlite3.Connection) -> Dict[str, Any]:
            """Commit the transcript and all bridge state under one writer lock."""

            _ensure_outbox_schema(conn)
            guard = getattr(db, "_check_transcript_write_guards", None)
            if callable(guard):
                guard(conn, session_id, None)
            accepted: List[str] = []
            inserted_messages = 0
            stored_tool_calls = 0
            tool_iterations = 0
            cursor = conn.execute(
                "SELECT thread_id, turn_id FROM codex_hermes_imports WHERE hermes_session_id = ?",
                (session_id,),
            )
            known = {(str(row[0]), str(row[1])) for row in cursor.fetchall()}
            offset = 0
            for turn_id, message_count, turn_tools in counts:
                if (thread_id, turn_id) in known:
                    offset += message_count
                    continue
                turn_messages = copy.deepcopy(projected[offset : offset + message_count])
                if turn_messages:
                    inserted, stored_tools = db._insert_message_rows(conn, session_id, turn_messages)
                    inserted_messages += inserted
                    stored_tool_calls += int(stored_tools)
                conn.execute(
                    "INSERT INTO codex_hermes_imports VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)",
                    (session_id, thread_id, turn_id, working_directory, message_count, turn_tools, time.time()),
                )
                known.add((thread_id, turn_id))
                accepted.append(turn_id)
                tool_iterations += turn_tools
                offset += message_count

            if inserted_messages:
                conn.execute(
                    "UPDATE sessions SET message_count = message_count + ?, "
                    "tool_call_count = tool_call_count + ? WHERE id = ?",
                    (inserted_messages, stored_tool_calls, session_id),
                )

            if not accepted:
                existing_review = conn.execute(
                    "SELECT id, snapshot_json FROM codex_hermes_review_outbox "
                    "WHERE hermes_session_id = ? AND thread_id = ?",
                    (session_id, thread_id),
                ).fetchone()
                snapshot_count = 0
                if existing_review:
                    try:
                        snapshot_count = len(json.loads(existing_review[1]))
                    except (TypeError, ValueError, json.JSONDecodeError):
                        snapshot_count = 0
                return {
                    "accepted": [],
                    "inserted_messages": 0,
                    "tool_iterations": 0,
                    "review_id": existing_review[0] if existing_review else None,
                    "snapshot_messages": snapshot_count,
                }

            snapshot = _snapshot_rows(db, conn, session_id)
            now = time.time()
            review_id = _review_id(session_id, thread_id)
            conn.execute(
                """INSERT INTO codex_hermes_review_outbox
                   (id, hermes_session_id, thread_id, profile_home, cwd, snapshot_json,
                    state, learning_status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending_review', ?, ?)
                   ON CONFLICT(hermes_session_id, thread_id) DO UPDATE SET
                     profile_home = excluded.profile_home, cwd = excluded.cwd,
                     snapshot_json = excluded.snapshot_json, state = 'pending',
                     learning_status = 'pending_review', updated_at = excluded.updated_at""",
                (review_id, session_id, thread_id, str(profile), working_directory, _json_text(snapshot), now, now),
            )
            title = str(thread_map.get("name") or thread_map.get("title") or f"Review Codex learning: {thread_id}")
            conn.execute(
                """INSERT INTO codex_hermes_learning_todos
                   (id, hermes_session_id, thread_id, profile_home, title, state, outbox_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'pending_review', ?, ?, ?)
                   ON CONFLICT(hermes_session_id, thread_id) DO UPDATE SET
                     profile_home = excluded.profile_home, title = excluded.title,
                     state = 'pending_review', outbox_id = excluded.outbox_id, updated_at = excluded.updated_at""",
                (f"{review_id}-learning", session_id, thread_id, str(profile), title, review_id, now, now),
            )
            return {
                "accepted": accepted,
                "inserted_messages": inserted_messages,
                "tool_iterations": tool_iterations,
                "review_id": review_id,
                "snapshot_messages": len(snapshot),
            }

        committed = db._execute_write(commit, patience_s=getattr(db, "_TRANSCRIPT_WRITE_PATIENCE_S", None))
    except HermesDependencyUnavailable:
        raise
    finally:
        close = getattr(db, "close", None)
        if callable(close):
            close()

    status = "imported" if committed["accepted"] else "already_imported"
    return {
        "status": status,
        "learning_status": "pending_review" if committed["review_id"] else "unchanged",
        "review_dispatch": "outbox_only",
        "profile_home": str(profile),
        "hermes_session_id": session_id,
        "thread_id": thread_id,
        "accepted_turn_ids": committed["accepted"],
        "skipped_turn_ids": skipped,
        "inserted_messages": committed["inserted_messages"],
        "tool_iterations": committed["tool_iterations"],
        "review_id": committed["review_id"],
        "snapshot_messages": committed.get("snapshot_messages", 0),
    }


def _claim_review(
    db: Any, profile: Path, review_id: Optional[str], lease_seconds: float,
) -> Optional[Dict[str, Any]]:
    """Atomically claim one pending review owned by ``profile``."""

    def claim(conn: sqlite3.Connection) -> Optional[Dict[str, Any]]:
        """Select and mark one outbox row while holding the SessionDB writer lock."""

        _ensure_outbox_schema(conn)
        now = time.time()
        available = "(state = 'pending' OR (state = 'running' AND (lease_until IS NULL OR lease_until <= ?)))"
        if review_id:
            row = conn.execute(
                f"SELECT * FROM codex_hermes_review_outbox WHERE id = ? AND profile_home = ? AND {available}",
                (review_id, str(profile), now),
            ).fetchone()
        else:
            row = conn.execute(
                f"SELECT * FROM codex_hermes_review_outbox WHERE profile_home = ? AND {available} "
                "ORDER BY updated_at ASC LIMIT 1",
                (str(profile), now),
            ).fetchone()
        if row is None:
            return None
        worker_token = uuid.uuid4().hex
        changed = conn.execute(
            "UPDATE codex_hermes_review_outbox SET state = 'running', attempts = attempts + 1, "
            "last_error = NULL, worker_token = ?, lease_until = ?, updated_at = ? "
            "WHERE id = ? AND profile_home = ? AND " + available,
            (worker_token, now + lease_seconds, now, row["id"], str(profile), now),
        ).rowcount
        if changed != 1:
            return None
        return dict(row) | {
            "attempts": int(row["attempts"] or 0) + 1,
            "worker_token": worker_token,
        }

    return db._execute_write(claim, patience_s=getattr(db, "_TRANSCRIPT_WRITE_PATIENCE_S", None))


def _settle_review(
    db: Any, profile: Path, job: Mapping[str, Any], success: bool,
    learning_changed: bool, error: Optional[str],
) -> bool:
    """Mark a claimed job completed only after a successful reviewer process.

    Failed jobs return to ``pending`` with an error for a later retry.  The
    learning todo follows the same transition and can never claim completion
    merely because a subprocess was started.
    """

    def settle(conn: sqlite3.Connection) -> bool:
        """Settle only the exact running row claimed for this profile."""

        now = time.time()
        if success:
            changed = conn.execute(
                "UPDATE codex_hermes_review_outbox SET state = 'completed', learning_status = 'completed', "
                "learning_changed = ?, last_error = NULL, worker_token = NULL, lease_until = NULL, "
                "updated_at = ? WHERE id = ? AND profile_home = ? AND state = 'running' AND worker_token = ?",
                (int(learning_changed), now, job["id"], str(profile), job["worker_token"]),
            ).rowcount
            if changed == 1:
                conn.execute(
                    "UPDATE codex_hermes_learning_todos SET state = 'completed', updated_at = ? "
                    "WHERE outbox_id = ? AND profile_home = ? AND state = 'pending_review'",
                    (now, job["id"], str(profile)),
                )
            return changed == 1
        changed = conn.execute(
            "UPDATE codex_hermes_review_outbox SET state = 'pending', learning_status = 'pending_review', "
            "last_error = ?, worker_token = NULL, lease_until = NULL, updated_at = ? "
            "WHERE id = ? AND profile_home = ? AND state = 'running' AND worker_token = ?",
            (error or "review process failed", now, job["id"], str(profile), job["worker_token"]),
        ).rowcount
        return changed == 1

    return bool(db._execute_write(settle, patience_s=getattr(db, "_TRANSCRIPT_WRITE_PATIENCE_S", None)))


def _launch_review_subprocess(
    job: Mapping[str, Any], profile: Path, source: Path, timeout_seconds: float,
) -> int:
    """Run the review child with only profile-scoped environment and no output capture."""

    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(profile),
        "HERMES_HOME": str(profile),
        "HERMES_TEST_ISOLATION": str(profile),
        "HERMES_SOURCE": str(source),
    }
    try:
        completed = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--review-job", str(profile), str(job["id"])],
            cwd=str(profile),
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return 124
    except OSError:
        return 127
    return int(completed.returncode)


def run_review_worker(
    profile_home: object,
    *,
    enabled: bool = False,
    review_id: Optional[str] = None,
    hermes_source: Optional[object] = None,
    timeout_seconds: float = 300.0,
    lease_seconds: Optional[float] = None,
    executor: Optional[Callable[[Mapping[str, Any], Path, Path, float], object]] = None,
) -> Dict[str, Any]:
    """Claim and execute one review only when the caller explicitly enables it.

    ``executor`` is an injectable process endpoint for tests.  Production uses
    a separate Python process with ``HERMES_HOME`` and ``HERMES_SOURCE`` pinned
    to the selected profile/source.  A missing source or ``enabled=False``
    leaves pending work untouched.
    """

    if not isinstance(profile_home, (str, os.PathLike)) or not str(profile_home).strip():
        raise ValueError("profile_home must be an explicit non-empty path")
    profile = Path(os.fspath(profile_home)).expanduser().resolve()
    if not enabled:
        return {"status": "disabled", "profile_home": str(profile), "review_id": review_id}
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    if lease_seconds is None:
        lease_seconds = max(timeout_seconds + 30.0, 300.0)
    if lease_seconds <= timeout_seconds:
        raise ValueError("lease_seconds must exceed timeout_seconds")
    source_text = os.fspath(hermes_source) if hermes_source is not None else os.environ.get("HERMES_SOURCE", "")
    if not str(source_text).strip():
        return {
            "status": "not_configured",
            "learning_status": "pending_review",
            "profile_home": str(profile),
            "review_id": review_id,
            "error": "review requires explicit hermes_source or HERMES_SOURCE",
        }
    source = Path(source_text).expanduser().resolve()
    if not source.is_dir() or not (source / "hermes_state.py").is_file():
        return {
            "status": "not_configured",
            "learning_status": "pending_review",
            "profile_home": str(profile),
            "review_id": review_id,
            "error": f"review source is unavailable: {source}",
        }
    if str(source) not in sys.path:
        sys.path.insert(0, str(source))
    try:
        session_db_type, _projector_type = _load_hermes_components()
    except HermesDependencyUnavailable as exc:
        return {
            "status": "dependency_unavailable",
            "learning_status": "pending_review",
            "profile_home": str(profile),
            "review_id": review_id,
            "error": str(exc),
        }
    db = session_db_type(db_path=profile / "state.db")
    try:
        job = _claim_review(db, profile, review_id, lease_seconds)
        if job is None:
            return {"status": "empty", "profile_home": str(profile), "review_id": review_id}
        try:
            raw_result = (executor or _launch_review_subprocess)(job, profile, source, timeout_seconds)
            return_code = int(raw_result.returncode) if hasattr(raw_result, "returncode") else raw_result
            if isinstance(raw_result, bool):
                success = raw_result is True
                learning_changed = success
            else:
                success = isinstance(return_code, int) and return_code in (0, 5)
                learning_changed = success and return_code == 0
            error = None if success else f"review process exited with code {return_code}"
        except Exception as exc:
            success = False
            learning_changed = False
            # Provider exceptions can contain request fragments or credentials;
            # keep only a stable class name in the durable outbox.
            error = f"review process failed: {type(exc).__name__}"
        settled = _settle_review(db, profile, job, success, learning_changed, error)
        return {
            "status": "completed" if success and settled else "failed_retryable",
            "learning_status": "completed" if success and settled else "pending_review",
            "learning_changed": bool(learning_changed) if success and settled else False,
            "profile_home": str(profile),
            "review_id": job["id"],
            "attempts": job["attempts"],
            "error": error,
        }
    finally:
        db.close()


def _run_review_job_in_child(profile_home: Path, review_id: str) -> int:
    """Run a claimed outbox snapshot through Hermes' detached background review API."""

    source_text = os.environ.get("HERMES_SOURCE", "").strip()
    if not source_text:
        return 2
    try:
        conn = sqlite3.connect(profile_home / "state.db")
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM codex_hermes_review_outbox WHERE id = ? AND profile_home = ? AND state = 'running'",
            (review_id, str(profile_home)),
        ).fetchone()
        conn.close()
        if row is None:
            return 3
        snapshot = json.loads(row["snapshot_json"])
        if not isinstance(snapshot, list):
            return 4
        _load_hermes_components()
        background_review = importlib.import_module("agent.background_review")
        review_enabled, task_cfg = background_review.load_background_review_settings()
        if not review_enabled:
            return 6
        run_fork = getattr(background_review, "_run_review_fork")
        state_type = getattr(background_review, "_ReviewForkState")
        from run_agent import AIAgent

        parent = AIAgent(
            quiet_mode=True, skip_background_review=True,
            session_id=row["hermes_session_id"], skip_context_files=True,
        )
        state = state_type()
        prompt = getattr(background_review, "_COMBINED_REVIEW_PROMPT")
        run_fork(parent, snapshot, prompt, task_cfg, None, state)
        summarize = getattr(background_review, "summarize_background_review_actions")
        actions = summarize(state.review_messages, snapshot)
        # 0 means the review made a durable learning change; 5 means the
        # review completed successfully but found nothing to change.  Both
        # are successful process outcomes, but only 0 claims an improvement.
        return 0 if actions else 5
    except Exception:
        return 1


def _child_main(argv: Sequence[str]) -> int:
    """Handle the private child command without printing review/provider output."""

    if len(argv) != 3 or argv[0] != "--review-job":
        return 64
    profile = Path(argv[1]).expanduser().resolve()
    os.environ["HERMES_HOME"] = str(profile)
    os.environ["HERMES_TEST_ISOLATION"] = str(profile)
    return _run_review_job_in_child(profile, argv[2])


__all__ = [
    "HermesDependencyUnavailable", "import_completed", "run_review_worker",
]


if __name__ == "__main__":
    raise SystemExit(_child_main(sys.argv[1:]))
