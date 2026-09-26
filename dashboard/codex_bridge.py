"""Codex app-server bridge for the Workbench web chat.

The bridge owns the small amount of durable state that the browser needs in
addition to Codex's history: profile/user session mappings, client request
acceptance, an adapter event sequence, and per-user read progress.  Codex is
still authoritative for turns and items; this module rehydrates missing
history instead of guessing from browser delivery order.

One sidecar process must own a bridge database.  A non-blocking file lock
fails fast when a second worker opens the same database, because separate
workers cannot share the in-memory Codex subscription registry.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import hashlib
import inspect
import json
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

from codex_attachments import AttachmentStore
from memory_context import build_codex_memory_instructions
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$")
_DEFAULT_TIMEOUT = 30.0
_MAX_PAGE = 200
_MAX_HISTORY_PAGES = 1000
_COMPLETION_LEASE = 120.0
_NOTIFICATION_QUEUE_MAX = 256
_NOTIFICATION_BATCH_MAX = 16
_NOTIFICATION_BATCH_WINDOW = 0.01
_PREVIEW_TURN_LIMIT = 8
_PREVIEW_ITEM_TEXT_LIMIT = 12000
_PREVIEW_TOOL_OUTPUT_LIMIT = 1200
_APPROVAL_METHODS = frozenset(
    {
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
    }
)
_APPROVAL_DECISIONS = frozenset({"accept", "acceptForSession", "decline"})
_GOAL_STATUSES = frozenset(
    {"active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"}
)

# The web bridge uses the same permission vocabulary as Codex's CLI, while
# translating it to the app-server fields required by each RPC method.
_PERMISSION_MODE_ENV = "HERMES_WORKBENCH_CODEX_PERMISSION_MODE"
_DEFAULT_PERMISSION_MODE = "default"
_FULL_ACCESS_PERMISSION_MODE = "dangerously-bypass-approvals-and-sandbox"
_FULL_ACCESS_PERMISSION_ALIAS = "dangerously-skip-permissions"


def _resolve_permission_mode(value: str | None = None) -> str:
    """Normalize the optional deployment permission mode without widening defaults."""

    raw = (value if value is not None else os.environ.get(_PERMISSION_MODE_ENV, "")).strip()
    if not raw or raw in {_DEFAULT_PERMISSION_MODE, "standard"}:
        return _DEFAULT_PERMISSION_MODE
    if raw in {_FULL_ACCESS_PERMISSION_MODE, _FULL_ACCESS_PERMISSION_ALIAS}:
        return _FULL_ACCESS_PERMISSION_MODE
    raise RuntimeError(
        f"{_PERMISSION_MODE_ENV} must be '{_DEFAULT_PERMISSION_MODE}' or "
        f"'{_FULL_ACCESS_PERMISSION_MODE}'"
    )


def _thread_permission_params(permission_mode: str) -> dict[str, Any]:
    """Return app-server thread fields for the selected permission mode."""

    if permission_mode == _FULL_ACCESS_PERMISSION_MODE:
        return {"approvalPolicy": "never", "sandbox": "danger-full-access"}
    return {}


def _turn_permission_params(permission_mode: str) -> dict[str, Any]:
    """Return app-server turn fields for the selected permission mode."""

    if permission_mode == _FULL_ACCESS_PERMISSION_MODE:
        return {
            "approvalPolicy": "never",
            "sandboxPolicy": {"type": "dangerFullAccess"},
        }
    return {}


def _compact_preview_item(item: dict[str, Any]) -> dict[str, Any]:
    """Keep the first paint useful while omitting large tool transcripts."""

    compact = dict(item)
    item_type = str(compact.get("type") or "").lower()
    tool_item = item_type in {
        "commandexecution",
        "filechange",
        "mcptoolcall",
        "dynamictoolcall",
        "websearch",
        "imageview",
        "collabagenttoolcall",
    }
    if tool_item:
        for key in ("result", "output", "aggregatedOutput", "aggregated_output"):
            compact.pop(key, None)
    for key in ("content", "text"):
        value = compact.get(key)
        if isinstance(value, str) and len(value) > _PREVIEW_ITEM_TEXT_LIMIT:
            compact[key] = f"{value[:_PREVIEW_ITEM_TEXT_LIMIT]}…"
    if item_type == "reasoning":
        summary = compact.get("summary")
        if isinstance(summary, list):
            compact["summary"] = [
                value[:_PREVIEW_TOOL_OUTPUT_LIMIT] + "…"
                if isinstance(value, str) and len(value) > _PREVIEW_TOOL_OUTPUT_LIMIT
                else value
                for value in summary
            ]
        content = compact.get("content")
        if isinstance(content, list):
            compact["content"] = content[:4]
    return compact


class JsonTransport(Protocol):
    """Minimal newline or WebSocket transport used by the JSON-RPC client."""

    async def send(self, message: dict[str, Any]) -> None: ...

    async def receive(self) -> dict[str, Any] | None: ...

    async def close(self) -> None: ...


class UnknownAcceptance(RuntimeError):
    """The upstream may have accepted a request before its reply was lost."""


class RpcFailure(RuntimeError):
    """An explicit JSON-RPC error returned by Codex."""

    def __init__(self, error: Any) -> None:
        """Keep the opaque upstream error available for the HTTP response."""

        self.error = error
        super().__init__(str(error))


def _rejected_placeholder_request(request: dict[str, Any]) -> bool:
    """Recognize the legacy error that proves no native turn was accepted."""
    if request.get("status") != "failed":
        return False
    try:
        payload = json.loads(request.get("payload") or "{}")
        error = json.loads(request.get("result") or "{}")
    except (TypeError, ValueError):
        return False
    return (isinstance(payload, dict) and isinstance(error, dict)
            and str(payload.get("threadId", "")).startswith("pending:")
            and "invalid thread id" in str(error.get("message", "")).lower())


class UnixJsonTransport:
    """Send one JSON object per line over a Unix domain socket."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """Store the connected stream pair."""

        self.reader = reader
        self.writer = writer
        self._write_lock = asyncio.Lock()

    @classmethod
    async def connect(cls, path: str) -> "UnixJsonTransport":
        """Connect to a configured app-server Unix socket."""

        reader, writer = await asyncio.open_unix_connection(path)
        return cls(reader, writer)

    async def send(self, message: dict[str, Any]) -> None:
        """Write one framed JSON-RPC message and flush it."""

        encoded = (json.dumps(message, separators=(",", ":")) + "\n").encode()
        async with self._write_lock:
            self.writer.write(encoded)
            await self.writer.drain()

    async def receive(self) -> dict[str, Any] | None:
        """Read one JSON-RPC message, returning ``None`` at EOF."""

        line = await self.reader.readline()
        if not line:
            return None
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError("Codex returned a non-object message")
        return value

    async def close(self) -> None:
        """Close the Unix stream."""

        self.writer.close()
        with contextlib.suppress(OSError):
            await self.writer.wait_closed()


class WebSocketJsonTransport:
    """Adapt the optional ``websockets`` package to the bridge transport."""

    def __init__(self, socket: Any) -> None:
        """Store a connected WebSocket object."""

        self.socket = socket

    @classmethod
    async def connect(cls, endpoint: str) -> "WebSocketJsonTransport":
        """Connect to a configured ``ws://`` or ``wss://`` app-server endpoint."""

        try:
            import websockets
        except ImportError as exc:  # pragma: no cover - depends on deployment extras
            raise RuntimeError("websockets is required for a ws Codex endpoint") from exc
        # Codex thread/resume snapshots grow with the conversation and can
        # legitimately exceed websockets' 1 MiB default receive limit.
        connect_options = {"max_size": None}
        token_file = os.environ.get("CODEX_APP_SERVER_TOKEN_FILE")
        if token_file is None:
            return cls(await websockets.connect(endpoint, **connect_options))
        try:
            token = Path(token_file).read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as exc:
            raise RuntimeError("CODEX_APP_SERVER_TOKEN_FILE could not be read") from exc
        if not token:
            raise RuntimeError("CODEX_APP_SERVER_TOKEN_FILE is empty")
        return cls(
            await websockets.connect(
                endpoint,
                additional_headers={"Authorization": f"Bearer {token}"},
                **connect_options,
            )
        )

    async def send(self, message: dict[str, Any]) -> None:
        """Send a JSON encoded WebSocket message."""

        await self.socket.send(json.dumps(message, separators=(",", ":")))

    async def receive(self) -> dict[str, Any] | None:
        """Receive and decode one WebSocket message."""

        raw = await self.socket.recv()
        if raw is None:
            return None
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Codex returned a non-object message")
        return value

    async def close(self) -> None:
        """Close the WebSocket connection."""

        await self.socket.close()


class JsonRpcConnection:
    """Multiplex concurrent JSON-RPC calls and publish upstream notifications."""

    def __init__(
        self,
        transport: JsonTransport,
        on_notification: Callable[[dict[str, Any]], Awaitable[None]],
        timeout: float = _DEFAULT_TIMEOUT,
        epoch: str | None = None,
        on_notification_batch: Callable[[list[dict[str, Any]]], Awaitable[None]] | None = None,
    ) -> None:
        """Create a connection with a shared writer and optional batched notification sink."""

        self.transport = transport
        self.on_notification = on_notification
        self.timeout = timeout
        self.epoch = epoch or uuid.uuid4().hex
        self._next_id = 1
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._write_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._notification_batch = on_notification_batch
        self._notification_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=_NOTIFICATION_QUEUE_MAX)
        self._notification_task: asyncio.Task[None] | None = None
        self._notification_error: BaseException | None = None
        self._failed_notifications: list[dict[str, Any]] = []
        self._notification_put_tasks: dict[asyncio.Task[None], dict[str, Any]] = {}
        self._closing = False
        self.closed = False

    async def start(self) -> None:
        """Start the reader and perform the app-server initialization handshake."""

        if self._notification_batch is not None:
            self._notification_task = asyncio.create_task(self._notification_loop())
        self._reader_task = asyncio.create_task(self._read_loop())
        await self.request(
            "initialize",
            {
                "clientInfo": {"name": "hermes-workbench", "title": "Hermes Workbench", "version": "0.1"},
                "capabilities": {"experimentalApi": True, "optOutOfNotifications": []},
            },
        )
        await self.transport.send({"method": "initialized", "params": {}})

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Issue a concurrent request and raise ``UnknownAcceptance`` on timeout."""

        if self.closed:
            raise UnknownAcceptance(f"Codex connection is closed before {method}")
        request_id = str(self._next_id)
        self._next_id += 1
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            async with self._write_lock:
                await self.transport.send({"id": request_id, "method": method, "params": params})
        except Exception as exc:
            self._pending.pop(request_id, None)
            self.closed = True
            raise UnknownAcceptance(f"could not send {method}") from exc
        try:
            response = await asyncio.wait_for(future, timeout=self.timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(request_id, None)
            raise UnknownAcceptance(f"no response for {method}") from exc
        if "error" in response:
            raise RpcFailure(response["error"])
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    async def drain_notifications(self) -> None:
        """Wait until notifications read before this call have reached the sink."""

        if self._notification_task is None:
            return
        await self._notification_queue.join()
        if self._notification_error is not None:
            raise UnknownAcceptance("notification persistence failed") from self._notification_error

    async def _read_loop(self) -> None:
        """Resolve responses and enqueue notifications until the connection ends."""

        try:
            while True:
                message = await self.transport.receive()
                if message is None:
                    break
                if "id" in message and ("result" in message or "error" in message):
                    future = self._pending.pop(str(message["id"]), None)
                    if future is not None and not future.done():
                        future.set_result(message)
                elif isinstance(message.get("method"), str):
                    if self._notification_batch is None:
                        await self.on_notification(message)
                    else:
                        await self._enqueue_notification(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fail_pending(str(exc))
        finally:
            # EOF and receive failures both make this upstream connection
            # unusable.  The notification worker remains alive so already read
            # events can finish their durable transaction before close().
            self.closed = True
            self._fail_pending("Codex connection closed")

    async def _enqueue_notification(self, message: dict[str, Any]) -> None:
        """Put one read notification in the bounded queue without dropping it."""

        put_task = asyncio.create_task(self._notification_queue.put(message))
        self._notification_put_tasks[put_task] = message
        put_task.add_done_callback(self._forget_notification_put)
        try:
            # Reader cancellation must not cancel a put that already owns a
            # notification.  close() waits for these puts before joining the
            # worker, and the worker drains them in FIFO order.
            await asyncio.shield(put_task)
        finally:
            if put_task.done():
                self._notification_put_tasks.pop(put_task, None)

    def _forget_notification_put(self, task: asyncio.Task[None]) -> None:
        """Remove a completed queue put from the close-time tracking set."""

        self._notification_put_tasks.pop(task, None)

    async def _notification_loop(self) -> None:
        """Batch queued notifications and retain failed input until shutdown."""

        assert self._notification_batch is not None
        try:
            while True:
                first = await self._notification_queue.get()
                if first is None:
                    self._notification_queue.task_done()
                    return
                batch = [first]
                if not self._closing:
                    await asyncio.sleep(_NOTIFICATION_BATCH_WINDOW)
                while len(batch) < _NOTIFICATION_BATCH_MAX:
                    try:
                        next_item = self._notification_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    if next_item is None:
                        self._notification_queue.task_done()
                        self._notification_queue.put_nowait(None)
                        break
                    batch.append(next_item)
                try:
                    await self._notification_batch(batch)
                except BaseException:
                    # Keep the exact input that was removed from the queue so a
                    # persistence failure is observable and cannot look like a
                    # successful delivery to a future owner of this process.
                    self._failed_notifications.extend(batch)
                    raise
                finally:
                    for _ in batch:
                        self._notification_queue.task_done()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._notification_error = exc
            self.closed = True
            self._fail_pending(f"notification persistence failed: {exc}")
            while True:
                try:
                    pending = self._notification_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                if pending is not None:
                    self._failed_notifications.append(pending)
                self._notification_queue.task_done()
            for task, pending in tuple(self._notification_put_tasks.items()):
                if not task.done():
                    self._failed_notifications.append(pending)
                    task.cancel()
            if self._reader_task is not None and self._reader_task is not asyncio.current_task():
                self._reader_task.cancel()

    def _fail_pending(self, detail: str) -> None:
        """Fail outstanding requests when notification persistence cannot continue."""

        error = UnknownAcceptance(detail)
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def close(self) -> None:
        """Stop input, drain durable notifications, and close the upstream transport."""

        self._closing = True
        self.closed = True
        if self._reader_task is not None:
            self._reader_task.cancel()
            await asyncio.gather(self._reader_task, return_exceptions=True)
        # A shielded put may outlive the reader cancellation while the bounded
        # queue is full.  Wait for it before queue.join(), otherwise join could
        # return before that notification has even entered the queue.
        while self._notification_put_tasks:
            tasks = tuple(self._notification_put_tasks)
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._notification_task is not None:
            if not self._notification_task.done():
                await self._notification_queue.join()
                await self._notification_queue.put(None)
            await asyncio.gather(self._notification_task, return_exceptions=True)
        await self.transport.close()

    async def respond(self, request_id: Any, result: dict[str, Any]) -> None:
        """Answer a server initiated request such as a command approval."""

        async with self._write_lock:
            await self.transport.send({"id": request_id, "result": result})


class BridgeStore:
    """SQLite persistence for identity-scoped mappings, requests, events, and reads."""

    def __init__(self, path: Path) -> None:
        """Open or create the database with a process-local lock."""

        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path = path.with_name(f".{path.name}.lock")
        self.lock_file = self.lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self.lock_file.close()
            raise RuntimeError(f"Codex bridge database is already open: {path}") from exc
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS codex_sessions (
                    user_id TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
                    thread_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'idle', title TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL,
                    PRIMARY KEY (user_id, profile, session_id)
                );
                CREATE TABLE IF NOT EXISTS codex_requests (
                    user_id TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
                    client_request_id TEXT NOT NULL, upstream_request_id TEXT,
                    status TEXT NOT NULL, turn_id TEXT, payload TEXT NOT NULL,
                    result TEXT, updated_at REAL NOT NULL,
                    PRIMARY KEY (user_id, profile, session_id, client_request_id)
                );
                CREATE TABLE IF NOT EXISTS codex_events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
                    profile TEXT NOT NULL, session_id TEXT NOT NULL, event_key TEXT NOT NULL,
                    method TEXT NOT NULL, payload TEXT NOT NULL, created_at REAL NOT NULL,
                    UNIQUE (user_id, profile, session_id, event_key)
                );
                CREATE TABLE IF NOT EXISTS codex_reads (
                    user_id TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
                    last_completed_seq INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (user_id, profile, session_id)
                );
                CREATE TABLE IF NOT EXISTS codex_approvals (
                    user_id TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
                    request_id TEXT NOT NULL, method TEXT NOT NULL, payload TEXT NOT NULL,
                    epoch TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'pending',
                    PRIMARY KEY (user_id, profile, session_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS codex_completion_hooks (
                    user_id TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL, claimed_at REAL NOT NULL DEFAULT 0,
                    completed INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (user_id, profile, session_id, turn_id)
                );
                CREATE TABLE IF NOT EXISTS codex_session_organization (
                    user_id TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
                    favorite INTEGER NOT NULL DEFAULT 0,
                    group_id TEXT,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (user_id, profile, session_id)
                );
                CREATE TABLE IF NOT EXISTS codex_session_groups (
                    user_id TEXT NOT NULL, profile TEXT NOT NULL, group_id TEXT NOT NULL,
                    name TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL,
                    PRIMARY KEY (user_id, profile, group_id),
                    UNIQUE (user_id, profile, workspace_id, workspace_path, name)
                );
                """
            )
            approval_columns = {str(row[1]) for row in self.connection.execute("PRAGMA table_info(codex_approvals)").fetchall()}
            if "state" not in approval_columns:
                self.connection.execute("ALTER TABLE codex_approvals ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'")
            if "epoch" not in approval_columns:
                self.connection.execute("ALTER TABLE codex_approvals ADD COLUMN epoch TEXT NOT NULL DEFAULT ''")
            session_columns = {str(row[1]) for row in self.connection.execute("PRAGMA table_info(codex_sessions)").fetchall()}
            if "title" not in session_columns:
                self.connection.execute("ALTER TABLE codex_sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''")
            if "created_at" not in session_columns:
                self.connection.execute("ALTER TABLE codex_sessions ADD COLUMN created_at REAL NOT NULL DEFAULT 0")
                for row in self.connection.execute("SELECT user_id,profile,session_id,thread_id,updated_at FROM codex_sessions").fetchall():
                    identity = (row["user_id"], row["profile"], row["session_id"])
                    candidates = [row["updated_at"]]
                    for table, column in (("codex_requests", "updated_at"), ("codex_events", "created_at")):
                        first = self.connection.execute(f"SELECT MIN({column}) FROM {table} WHERE user_id=? AND profile=? AND session_id=?", identity).fetchone()[0]
                        if first is not None:
                            candidates.append(first)
                    try:
                        native_id = uuid.UUID(row["thread_id"])
                        if native_id.version == 7:
                            candidates.append((native_id.int >> 80) / 1000)
                    except ValueError:
                        pass
                    self.connection.execute("UPDATE codex_sessions SET created_at=? WHERE user_id=? AND profile=? AND session_id=?", (min(candidates), *identity))
            # Recover names without opening every conversation or querying upstream.
            for row in self.connection.execute("SELECT user_id,profile,session_id FROM codex_sessions WHERE title='' OR title=session_id").fetchall():
                identity = (row["user_id"], row["profile"], row["session_id"])
                for request in self.connection.execute("SELECT payload FROM codex_requests WHERE user_id=? AND profile=? AND session_id=? ORDER BY rowid", identity).fetchall():
                    try:
                        inputs = json.loads(request["payload"]).get("input", [])
                        title = " ".join(item.get("text", "") for item in inputs if isinstance(item, dict) and item.get("type") == "text").strip()
                    except (TypeError, ValueError, AttributeError):
                        continue
                    if title:
                        self.set_title_if_empty(*identity, title)
                        break
            completion_columns = {str(row[1]) for row in self.connection.execute("PRAGMA table_info(codex_completion_hooks)").fetchall()}
            if "claimed_at" not in completion_columns:
                self.connection.execute("ALTER TABLE codex_completion_hooks ADD COLUMN claimed_at REAL NOT NULL DEFAULT 0")
            if "completed" not in completion_columns:
                self.connection.execute("ALTER TABLE codex_completion_hooks ADD COLUMN completed INTEGER NOT NULL DEFAULT 0")
            self.connection.commit()

    def _row(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        """Convert a SQLite row into JSON-friendly values."""

        return dict(row) if row is not None else None

    def _last_completed_seq(self, user: str, profile: str, session_id: str) -> int:
        """Find the latest event that represents a successfully completed turn."""

        rows = self.connection.execute("SELECT seq,method,payload FROM codex_events WHERE user_id=? AND profile=? AND session_id=? AND method IN ('turn/completed','history/turn') ORDER BY seq", (user, profile, session_id)).fetchall()
        latest = 0
        for row in rows:
            if row["method"] == "history/turn":
                latest = int(row["seq"])
                continue
            try:
                turn = json.loads(row["payload"]).get("params", {}).get("turn", {})
            except (TypeError, json.JSONDecodeError):
                turn = {}
            if not isinstance(turn, dict) or turn.get("status") in (None, "completed"):
                latest = int(row["seq"])
        return latest

    def close(self) -> None:
        """Close the SQLite handle after all bridge tasks have stopped."""

        with self.lock:
            self.connection.close()
            fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_UN)
            self.lock_file.close()

    def session(self, user: str, profile: str, session_id: str) -> dict[str, Any] | None:
        """Read one identity-scoped session mapping."""

        with self.lock:
            value = self._row(self.connection.execute(
                """SELECT s.*, COALESCE(o.favorite, 0) AS favorite,
                    o.group_id AS organization_group_id, COALESCE(o.deleted, 0) AS deleted
                    FROM codex_sessions AS s
                    LEFT JOIN codex_session_organization AS o
                    ON o.user_id=s.user_id AND o.profile=s.profile AND o.session_id=s.session_id
                    WHERE s.user_id=? AND s.profile=? AND s.session_id=?""",
                (user, profile, session_id),
            ).fetchone())
            if value is None:
                return None
            value["favorite"] = bool(value.get("favorite"))
            value["groupId"] = value.pop("organization_group_id")
            value["deleted"] = bool(value.get("deleted"))
            value["id"] = value["session_id"]
            value["workspace"] = value["workspace_id"]
            value["workspacePath"] = value["workspace_path"]
            value["updatedAt"] = value["updated_at"]
            value["title"] = value.get("title") or value["session_id"]
            completed = self._last_completed_seq(user, profile, session_id)
            read = self.connection.execute("SELECT last_completed_seq FROM codex_reads WHERE user_id=? AND profile=? AND session_id=?", (user, profile, session_id)).fetchone()
            value["lastCompletedSeq"] = int(completed or 0)
            value["readSeq"] = int(read[0]) if read else 0
            value["unread"] = value["lastCompletedSeq"] > value["readSeq"]
            return value

    def session_by_thread(self, user: str, profile: str, thread_id: str) -> dict[str, Any] | None:
        """Find one mapped session by its exact Codex thread id."""

        with self.lock:
            row = self.connection.execute("SELECT * FROM codex_sessions WHERE user_id=? AND profile=? AND thread_id=? LIMIT 1", (user, profile, thread_id)).fetchone()
        if row is None:
            return None
        return self.session(user, profile, str(row["session_id"]))

    def upsert_session(self, user: str, profile: str, value: dict[str, Any]) -> dict[str, Any]:
        """Create or update one identity-scoped Codex session mapping."""

        now = time.time()
        with self.lock:
            try:
                self.connection.execute(
                    """INSERT INTO codex_sessions
                (user_id,profile,session_id,thread_id,workspace_id,workspace_path,status,title,updated_at,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,profile,session_id) DO UPDATE SET
                thread_id=excluded.thread_id,workspace_id=excluded.workspace_id,
                workspace_path=excluded.workspace_path,status=excluded.status,
                title=CASE WHEN excluded.title <> '' THEN excluded.title ELSE codex_sessions.title END,
                updated_at=excluded.updated_at""",
                    (user, profile, value["session_id"], value["thread_id"], value["workspace_id"], value["workspace_path"], value.get("status", "idle"), "" if value.get("title") == value["session_id"] else value.get("title", ""), now, now),
                )
                self.connection.execute(
                    "INSERT OR IGNORE INTO codex_session_organization(user_id,profile,session_id) VALUES(?,?,?)",
                    (user, profile, value["session_id"]),
                )
                self.connection.commit()
            except Exception:
                self.connection.rollback()
                raise
        return self.session(user, profile, value["session_id"]) or value

    def list_sessions(self, user: str, profile: str, limit: int, offset: int, deleted: bool = False) -> list[dict[str, Any]]:
        """Return a bounded page of active sessions or the identity's trash."""

        with self.lock:
            rows = self.connection.execute(
                """SELECT s.*, COALESCE(o.favorite, 0) AS favorite,
                    o.group_id AS organization_group_id, COALESCE(o.deleted, 0) AS deleted
                    FROM codex_sessions AS s
                    LEFT JOIN codex_session_organization AS o
                    ON o.user_id=s.user_id AND o.profile=s.profile AND o.session_id=s.session_id
                    WHERE s.user_id=? AND s.profile=? AND COALESCE(o.deleted, 0)=?
                    ORDER BY s.created_at DESC, s.rowid DESC LIMIT ? OFFSET ?""",
                (user, profile, int(deleted), limit, offset),
            ).fetchall()
            result = []
            for row in rows:
                value = dict(row)
                value["favorite"] = bool(value.get("favorite"))
                value["groupId"] = value.pop("organization_group_id")
                value["deleted"] = bool(value.get("deleted"))
                value["lastCompletedSeq"] = self._last_completed_seq(user, profile, value["session_id"])
                read = self.connection.execute("SELECT last_completed_seq FROM codex_reads WHERE user_id=? AND profile=? AND session_id=?", (user, profile, value["session_id"])).fetchone()
                value["readSeq"] = int(read[0]) if read else 0
                value["unread"] = value["lastCompletedSeq"] > value["readSeq"]
                value["title"] = value.get("title") or value["session_id"]
                value["id"] = value["session_id"]
                value["workspace"] = value["workspace_id"]
                value["workspacePath"] = value["workspace_path"]
                value["updatedAt"] = value["updated_at"]
                value["createdAt"] = value["created_at"]
                result.append(value)
            return result

    def groups(self, user: str, profile: str) -> list[dict[str, Any]]:
        """Return groups owned by one exact user and profile."""

        with self.lock:
            rows = self.connection.execute(
                "SELECT group_id,name,workspace_id,workspace_path FROM codex_session_groups WHERE user_id=? AND profile=? ORDER BY name,group_id",
                (user, profile),
            ).fetchall()
        return [self._group_value(row) for row in rows]

    def _group_value(self, row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        """Convert a stored group row to the public group response fields."""

        value = dict(row)
        return {
            "id": value["group_id"],
            "name": value["name"],
            "workspaceId": value["workspace_id"],
            "workspacePath": value["workspace_path"],
        }

    def create_group(self, user: str, profile: str, workspace_id: str, workspace_path: str, name: str) -> dict[str, Any]:
        """Create a logical group; legacy workspace columns remain storage-only metadata."""

        now = time.time()
        group_id = str(uuid.uuid4())
        with self.lock:
            if self.connection.execute(
                "SELECT 1 FROM codex_session_groups WHERE user_id=? AND profile=? AND name=?",
                (user, profile, name),
            ).fetchone():
                raise HTTPException(status_code=409, detail="A group with this name already exists")
            try:
                self.connection.execute(
                    "INSERT INTO codex_session_groups(user_id,profile,group_id,name,workspace_id,workspace_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (user, profile, group_id, name, workspace_id, workspace_path, now, now),
                )
                self.connection.commit()
            except sqlite3.IntegrityError as exc:
                self.connection.rollback()
                raise HTTPException(status_code=409, detail="A group with this name already exists") from exc
            row = self.connection.execute(
                "SELECT group_id,name,workspace_id,workspace_path FROM codex_session_groups WHERE user_id=? AND profile=? AND group_id=?",
                (user, profile, group_id),
            ).fetchone()
        if row is None:
            raise RuntimeError("created group was not persisted")
        return self._group_value(row)

    def group(self, user: str, profile: str, group_id: str) -> dict[str, Any] | None:
        """Read one group inside the exact user and profile scope."""

        with self.lock:
            row = self.connection.execute(
                "SELECT group_id,name,workspace_id,workspace_path FROM codex_session_groups WHERE user_id=? AND profile=? AND group_id=?",
                (user, profile, group_id),
            ).fetchone()
        return self._group_value(row) if row is not None else None

    def rename_group(self, user: str, profile: str, group_id: str, name: str) -> dict[str, Any]:
        """Rename one logical group while preserving its identity and membership."""

        with self.lock:
            current = self.connection.execute(
                "SELECT group_id,workspace_id,workspace_path FROM codex_session_groups WHERE user_id=? AND profile=? AND group_id=?",
                (user, profile, group_id),
            ).fetchone()
            if current is None:
                raise HTTPException(status_code=404, detail="Group not found")
            if self.connection.execute(
                "SELECT 1 FROM codex_session_groups WHERE user_id=? AND profile=? AND name=? AND group_id<>?",
                (user, profile, name, group_id),
            ).fetchone():
                raise HTTPException(status_code=409, detail="A group with this name already exists")
            try:
                self.connection.execute(
                    "UPDATE codex_session_groups SET name=?,updated_at=? WHERE user_id=? AND profile=? AND group_id=?",
                    (name, time.time(), user, profile, group_id),
                )
                self.connection.commit()
            except sqlite3.IntegrityError as exc:
                self.connection.rollback()
                raise HTTPException(status_code=409, detail="A group with this name already exists") from exc
            row = self.connection.execute(
                "SELECT group_id,name,workspace_id,workspace_path FROM codex_session_groups WHERE user_id=? AND profile=? AND group_id=?",
                (user, profile, group_id),
            ).fetchone()
        if row is None:
            raise RuntimeError("renamed group was not persisted")
        return self._group_value(row)

    def delete_group(self, user: str, profile: str, group_id: str) -> None:
        """Delete a group and move its sessions to the ungrouped state."""

        with self.lock:
            try:
                self.connection.execute("BEGIN")
                row = self.connection.execute(
                    "SELECT 1 FROM codex_session_groups WHERE user_id=? AND profile=? AND group_id=?",
                    (user, profile, group_id),
                ).fetchone()
                if row is None:
                    self.connection.rollback()
                    raise HTTPException(status_code=404, detail="Group not found")
                self.connection.execute(
                    "UPDATE codex_session_organization SET group_id=NULL WHERE user_id=? AND profile=? AND group_id=?",
                    (user, profile, group_id),
                )
                self.connection.execute(
                    "DELETE FROM codex_session_groups WHERE user_id=? AND profile=? AND group_id=?",
                    (user, profile, group_id),
                )
                self.connection.commit()
            except HTTPException:
                raise
            except Exception:
                self.connection.rollback()
                raise

    def has_active_approval(self, user: str, profile: str, session_id: str) -> bool:
        """Report whether a session still owns an unresolved approval request."""

        with self.lock:
            row = self.connection.execute(
                "SELECT 1 FROM codex_approvals WHERE user_id=? AND profile=? AND session_id=? AND state IN ('pending','sending','unknown') LIMIT 1",
                (user, profile, session_id),
            ).fetchone()
        return row is not None

    def has_active_submission(self, user: str, profile: str, session_id: str) -> bool:
        """Report whether a turn request is awaiting a durable upstream outcome."""

        with self.lock:
            row = self.connection.execute(
                "SELECT 1 FROM codex_requests WHERE user_id=? AND profile=? AND session_id=? AND status IN ('pending','unknown') LIMIT 1",
                (user, profile, session_id),
            ).fetchone()
        return row is not None

    def has_submission(self, user: str, profile: str, session_id: str) -> bool:
        """Exclude only placeholder requests known to have been rejected."""

        with self.lock:
            rows = self.connection.execute(
                "SELECT status,payload,result FROM codex_requests WHERE user_id=? AND profile=? AND session_id=?",
                (user, profile, session_id),
            ).fetchall()
        return any(not _rejected_placeholder_request(dict(row)) for row in rows)

    def has_non_thread_event(self, user: str, profile: str, session_id: str) -> bool:
        """Report whether native persistence has observed activity beyond thread creation."""

        with self.lock:
            row = self.connection.execute(
                "SELECT 1 FROM codex_events WHERE user_id=? AND profile=? AND session_id=? AND method NOT IN ('thread/started','mcpServer/startupStatus/updated') LIMIT 1",
                (user, profile, session_id),
            ).fetchone()
        return row is not None

    def mark_submission_running(self, user: str, profile: str, session_id: str, turn_id: str) -> dict[str, Any] | None:
        """Mark this returned turn active unless its own terminal event is persisted."""

        if not turn_id:
            return self.session(user, profile, session_id)
        with self.lock:
            rows = self.connection.execute(
                "SELECT method,payload FROM codex_events WHERE user_id=? AND profile=? AND session_id=? AND method IN ('turn/completed','history/turn','turn/started') ORDER BY seq DESC",
                (user, profile, session_id),
            ).fetchall()
            terminal = False
            for row in rows:
                try:
                    params = json.loads(row["payload"]).get("params", {})
                except (TypeError, json.JSONDecodeError):
                    continue
                turn = params.get("turn") if isinstance(params, dict) else None
                if not isinstance(turn, dict) or str(turn.get("id") or "") != turn_id:
                    continue
                if row["method"] in {"turn/completed", "history/turn"} and str(turn.get("status") or "completed") in {"completed", "failed", "interrupted"}:
                    terminal = True
                    break
            if not terminal:
                self.connection.execute(
                    "UPDATE codex_sessions SET status='running',updated_at=? WHERE user_id=? AND profile=? AND session_id=?",
                    (time.time(), user, profile, session_id),
                )
                self.connection.commit()
        return self.session(user, profile, session_id)

    def update_organization(self, user: str, profile: str, session_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Atomically update provided favorite, group, and deleted fields."""

        if not values:
            raise HTTPException(status_code=400, detail="Organization patch cannot be empty")
        with self.lock:
            try:
                session_row = self.connection.execute(
                    "SELECT * FROM codex_sessions WHERE user_id=? AND profile=? AND session_id=?",
                    (user, profile, session_id),
                ).fetchone()
                if session_row is None:
                    raise HTTPException(status_code=404, detail="Session not found")
                self.connection.execute(
                    "INSERT OR IGNORE INTO codex_session_organization(user_id,profile,session_id) VALUES(?,?,?)",
                    (user, profile, session_id),
                )
                current = self.connection.execute(
                    "SELECT favorite,group_id,deleted FROM codex_session_organization WHERE user_id=? AND profile=? AND session_id=?",
                    (user, profile, session_id),
                ).fetchone()
                if current is None:
                    raise RuntimeError("session organization was not initialized")
                if "groupId" in values and values["groupId"] is not None:
                    group = self.connection.execute(
                        "SELECT workspace_id,workspace_path FROM codex_session_groups WHERE user_id=? AND profile=? AND group_id=?",
                        (user, profile, str(values["groupId"])),
                    ).fetchone()
                    if group is None:
                        raise HTTPException(status_code=404, detail="Group not found")
                if values.get("deleted") is True and not bool(current["deleted"]):
                    status = str(session_row["status"] or "").lower()
                    if (
                        status in {"running", "waiting", "active", "inprogress"}
                        or self.has_active_approval(user, profile, session_id)
                        or self.has_active_submission(user, profile, session_id)
                    ):
                        raise HTTPException(status_code=409, detail="Running or awaiting session cannot be archived")
                fields: list[str] = []
                params: list[Any] = []
                if "favorite" in values:
                    fields.append("favorite=?")
                    params.append(int(bool(values["favorite"])))
                if "groupId" in values:
                    fields.append("group_id=?")
                    params.append(values["groupId"])
                if "deleted" in values:
                    fields.append("deleted=?")
                    params.append(int(bool(values["deleted"])))
                if not fields:
                    raise HTTPException(status_code=400, detail="Organization patch cannot be empty")
                params.extend((user, profile, session_id))
                self.connection.execute(
                    f"UPDATE codex_session_organization SET {','.join(fields)} WHERE user_id=? AND profile=? AND session_id=?",
                    params,
                )
                self.connection.commit()
            except HTTPException:
                self.connection.rollback()
                raise
            except Exception:
                self.connection.rollback()
                raise
        result = self.session(user, profile, session_id)
        if result is None:
            raise RuntimeError("updated session was not persisted")
        return result

    def all_sessions(self, user: str, profile: str) -> list[dict[str, Any]]:
        """Return every mapped session for reconnect recovery."""

        with self.lock:
            rows = self.connection.execute("SELECT session_id FROM codex_sessions WHERE user_id=? AND profile=? ORDER BY updated_at DESC", (user, profile)).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            value = self.session(user, profile, str(row["session_id"]))
            if value is not None:
                result.append(value)
        return result

    def request(self, user: str, profile: str, session_id: str, client_id: str) -> dict[str, Any] | None:
        """Read an idempotency record for one client submission."""

        with self.lock:
            return self._row(self.connection.execute(
                "SELECT * FROM codex_requests WHERE user_id=? AND profile=? AND session_id=? AND client_request_id=?",
                (user, profile, session_id, client_id),
            ).fetchone())

    def set_title_if_empty(self, user: str, profile: str, session_id: str, title: str) -> None:
        """Set a first-message title without overwriting a user-selected title."""

        # A pasted diagnostic ID is message content, not a useful status/title.
        title = re.sub(r"^pending:session-[0-9a-fA-F-]{36}\s+", "", title.strip())
        title = " ".join(title.split())[:80]
        if not title:
            return
        with self.lock:
            self.connection.execute("UPDATE codex_sessions SET title=? WHERE user_id=? AND profile=? AND session_id=? AND (title='' OR title=session_id)", (title, user, profile, session_id))
            self.connection.commit()

    def save_request(self, user: str, profile: str, session_id: str, client_id: str, **values: Any) -> dict[str, Any]:
        """Insert or update a client request without changing its identity."""

        existing = self.request(user, profile, session_id, client_id)
        payload = values.get("payload", existing.get("payload", "{}") if existing else "{}")
        now = time.time()
        with self.lock:
            self.connection.execute(
                """INSERT INTO codex_requests
                (user_id,profile,session_id,client_request_id,upstream_request_id,status,turn_id,payload,result,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,profile,session_id,client_request_id) DO UPDATE SET
                upstream_request_id=COALESCE(excluded.upstream_request_id,codex_requests.upstream_request_id),
                status=excluded.status,turn_id=COALESCE(excluded.turn_id,codex_requests.turn_id),
                result=COALESCE(excluded.result,codex_requests.result),updated_at=excluded.updated_at""",
                (user, profile, session_id, client_id, values.get("upstream_request_id"), values.get("status", "pending"), values.get("turn_id"), payload, values.get("result"), now),
            )
            self.connection.commit()
        return self.request(user, profile, session_id, client_id) or {}

    def _event_key(self, method: str, payload: dict[str, Any]) -> str:
        """Build the existing semantic event key used by live and replay writes."""

        params = payload.get("params", {})
        item = params.get("item", {}) if isinstance(params, dict) else {}
        item_id = item.get("id") if isinstance(item, dict) else None
        # Lifecycle events are replayable and therefore deduplicated by their
        # semantic identity. Delta events intentionally retain every chunk:
        # equal text in adjacent chunks is still distinct model output.
        if method in {"item/started", "item/completed"} and item_id:
            key = f"{method}:{item_id}"
        elif method.lower().startswith("item/") and any(token in method.lower() for token in ("delta", "textdelta", "summarypartadded", "outputdelta")):
            key = f"{method}:{uuid.uuid4()}"
        elif isinstance(params, dict) and params.get("approvalId") is not None:
            key = f"{method}:request:{params['approvalId']}"
        elif payload.get("id") is not None:
            key = f"{method}:request:{payload['id']}"
        else:
            key = f"{method}:{hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()}"
        return key

    def append_events(self, entries: list[tuple[str, str, str, str, dict[str, Any]]]) -> list[dict[str, Any]]:
        """Durably append an ordered batch and return rows only after one FULL commit."""

        if not entries:
            return []
        with self.lock:
            rows: list[dict[str, Any]] = []
            try:
                for user, profile, session_id, method, payload in entries:
                    key = self._event_key(method, payload)
                    identity = (user, profile, session_id, key)
                    row = self.connection.execute(
                        "SELECT seq,method,payload,created_at FROM codex_events WHERE user_id=? AND profile=? AND session_id=? AND event_key=?",
                        identity,
                    ).fetchone()
                    # INSERT OR IGNORE advances SQLite's AUTOINCREMENT counter
                    # even for duplicates. Reopening history must remain read-only.
                    if row is None:
                        self.connection.execute(
                            "INSERT INTO codex_events(user_id,profile,session_id,event_key,method,payload,created_at) VALUES(?,?,?,?,?,?,?)",
                            (user, profile, session_id, key, method, json.dumps(payload, separators=(",", ":")), time.time()),
                        )
                        row = self.connection.execute(
                            "SELECT seq,method,payload,created_at FROM codex_events WHERE user_id=? AND profile=? AND session_id=? AND event_key=?",
                            identity,
                        ).fetchone()
                    if row is None:
                        raise RuntimeError("event was not persisted")
                    rows.append({"seq": row["seq"], "method": row["method"], "payload": json.loads(row["payload"]), "created_at": row["created_at"]})
                self.connection.commit()
                return rows
            except Exception:
                self.connection.rollback()
                raise

    def append_event(self, user: str, profile: str, session_id: str, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Append one deduplicated upstream event with the synchronous write path."""

        return self.append_events([(user, profile, session_id, method, payload)])[0]

    def events(self, user: str, profile: str, session_id: str, after: int, limit: int = _MAX_PAGE) -> list[dict[str, Any]]:
        """Read adapter events after an inclusive cursor for one identity."""

        with self.lock:
            rows = self.connection.execute(
                "SELECT seq,method,payload,created_at FROM codex_events WHERE user_id=? AND profile=? AND session_id=? AND seq>? ORDER BY seq LIMIT ?",
                (user, profile, session_id, after, limit),
            ).fetchall()
        return [{"seq": row["seq"], "method": row["method"], "payload": json.loads(row["payload"]), "created_at": row["created_at"]} for row in rows]

    def event_highwater(self, user: str, profile: str, session_id: str) -> int:
        """Return the latest adapter sequence for one identity-scoped session."""

        with self.lock:
            row = self.connection.execute("SELECT COALESCE(MAX(seq),0) FROM codex_events WHERE user_id=? AND profile=? AND session_id=?", (user, profile, session_id)).fetchone()
        return int(row[0])

    def events_between(self, user: str, profile: str, session_id: str, after: int, through: int) -> list[dict[str, Any]]:
        """Read the complete finite event interval used to bridge a snapshot race."""

        with self.lock:
            rows = self.connection.execute("SELECT seq,method,payload,created_at FROM codex_events WHERE user_id=? AND profile=? AND session_id=? AND seq>? AND seq<=? ORDER BY seq", (user, profile, session_id, after, through)).fetchall()
        return [{"seq": row["seq"], "method": row["method"], "payload": json.loads(row["payload"]), "created_at": row["created_at"]} for row in rows]

    def cached_history_preview(self, user: str, profile: str, session_id: str, limit: int = _PREVIEW_TURN_LIMIT) -> dict[str, Any] | None:
        """Rebuild a small recent-turn snapshot from the local history archive."""

        bounded_limit = min(max(int(limit), 1), _PREVIEW_TURN_LIMIT)
        with self.lock:
            marker_rows = self.connection.execute(
                """SELECT seq,method,payload FROM codex_events
                   WHERE user_id=? AND profile=? AND session_id=?
                     AND method IN ('history/turn','history/turn-status')
                   ORDER BY seq DESC""",
                (user, profile, session_id),
            ).fetchall()
            selected: list[tuple[int, dict[str, Any]]] = []
            seen_turns: set[str] = set()
            for row in marker_rows:
                try:
                    payload = json.loads(row["payload"])
                    turn = payload.get("params", {}).get("turn", {})
                except (TypeError, ValueError, AttributeError):
                    continue
                if not isinstance(turn, dict):
                    continue
                turn_id = str(turn.get("id") or "")
                if not turn_id or turn_id in seen_turns:
                    continue
                seen_turns.add(turn_id)
                selected.append((int(row["seq"]), turn))
                if len(selected) >= bounded_limit:
                    break
            if not selected:
                return None
            turn_ids = {str(turn.get("id")) for _, turn in selected}
            items_by_turn: dict[str, list[dict[str, Any]]] = {turn_id: [] for turn_id in turn_ids}
            item_rows = self.connection.execute(
                """SELECT payload FROM codex_events
                   WHERE user_id=? AND profile=? AND session_id=? AND method='history/item'
                   ORDER BY seq""",
                (user, profile, session_id),
            ).fetchall()
            for row in item_rows:
                try:
                    params = json.loads(row["payload"]).get("params", {})
                    turn_id = str(params.get("turnId") or "")
                    item = params.get("item")
                except (TypeError, ValueError, AttributeError):
                    continue
                if turn_id in items_by_turn and isinstance(item, dict):
                    items_by_turn[turn_id].append(_compact_preview_item(item))
            turns: list[dict[str, Any]] = []
            for _, turn in reversed(selected):
                value = dict(turn)
                value["items"] = items_by_turn.get(str(value.get("id")), [])
                value["itemsView"] = "full"
                turns.append(value)
            snapshot_seq = self.event_highwater(user, profile, session_id)
            return {"turns": turns, "snapshotSeq": snapshot_seq}

    def pending_approvals(self, user: str, profile: str, session_id: str) -> list[dict[str, Any]]:
        """Return only unresolved approval requests owned by this session."""

        with self.lock:
            rows = self.connection.execute("SELECT request_id,method,payload FROM codex_approvals WHERE user_id=? AND profile=? AND session_id=? AND state='pending' ORDER BY request_id", (user, profile, session_id)).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            try:
                message = json.loads(row["payload"])
            except (TypeError, json.JSONDecodeError):
                message = {}
            params = message.get("params", {})
            if not isinstance(params, dict):
                params = {}
            params = {**params, "approvalId": row["request_id"]}
            result.append({"requestId": row["request_id"], "method": row["method"], "params": params})
        return result

    def pending_requests(self, user: str, profile: str, session_id: str) -> list[dict[str, Any]]:
        """Return this identity's unconfirmed turn submissions for recovery UI."""

        with self.lock:
            rows = self.connection.execute("SELECT client_request_id,status,turn_id,payload,result,updated_at FROM codex_requests WHERE user_id=? AND profile=? AND session_id=? AND status IN ('pending','unknown','failed') ORDER BY updated_at", (user, profile, session_id)).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except (TypeError, json.JSONDecodeError):
                payload = {}
            result.append({"client_request_id": row["client_request_id"], "clientRequestId": row["client_request_id"], "status": row["status"], "turn_id": row["turn_id"], "payload": payload, "result": row["result"], "updated_at": row["updated_at"]})
        return result

    def latest_live_status(self, user: str, profile: str, session_id: str, after: int = 0) -> str | None:
        """Read the newest live turn status, excluding synthetic history markers."""

        with self.lock:
            rows = self.connection.execute("SELECT method,payload FROM codex_events WHERE user_id=? AND profile=? AND session_id=? AND seq>? AND method IN ('turn/started','turn/completed') ORDER BY seq DESC LIMIT 1", (user, profile, session_id, after)).fetchall()
        if not rows:
            return None
        try:
            params = json.loads(rows[0]["payload"]).get("params", {})
        except (TypeError, json.JSONDecodeError):
            params = {}
        turn = params.get("turn") if isinstance(params, dict) else None
        return str(turn.get("status")) if isinstance(turn, dict) and turn.get("status") else ("running" if rows[0]["method"] == "turn/started" else "completed")

    def read_progress(self, user: str, profile: str, session_id: str) -> int:
        """Read the monotonic completed-reply cursor."""

        with self.lock:
            row = self.connection.execute("SELECT last_completed_seq FROM codex_reads WHERE user_id=? AND profile=? AND session_id=?", (user, profile, session_id)).fetchone()
        return int(row[0]) if row else 0

    def reconcile_request(self, user: str, profile: str, session_id: str, client_id: str, turn_id: str) -> dict[str, Any] | None:
        """Resolve an unknown request only when Codex history carries its client id."""

        with self.lock:
            self.connection.execute(
                "UPDATE codex_requests SET status='accepted',turn_id=?,updated_at=? WHERE user_id=? AND profile=? AND session_id=? AND client_request_id=? AND status IN ('pending','unknown')",
                (turn_id, time.time(), user, profile, session_id, client_id),
            )
            self.connection.commit()
        return self.request(user, profile, session_id, client_id)

    def mark_read(self, user: str, profile: str, session_id: str, seq: int) -> int:
        """Advance read progress monotonically and return the stored cursor."""

        with self.lock:
            completed = self._last_completed_seq(user, profile, session_id)
            seq = min(seq, int(completed or 0))
            self.connection.execute(
                """INSERT INTO codex_reads(user_id,profile,session_id,last_completed_seq) VALUES(?,?,?,?)
                ON CONFLICT(user_id,profile,session_id) DO UPDATE SET last_completed_seq=MAX(last_completed_seq,excluded.last_completed_seq)""",
                (user, profile, session_id, seq),
            )
            self.connection.commit()
            return int(self.connection.execute("SELECT last_completed_seq FROM codex_reads WHERE user_id=? AND profile=? AND session_id=?", (user, profile, session_id)).fetchone()[0])

    def save_approval(self, user: str, profile: str, session_id: str, request_id: str, method: str, payload: dict[str, Any], epoch: str = "") -> None:
        """Bind an upstream approval request to its owning identity and session."""

        with self.lock:
            self.connection.execute("INSERT OR REPLACE INTO codex_approvals(user_id,profile,session_id,request_id,method,payload,epoch,state) VALUES(?,?,?,?,?,?,?,'pending')", (user, profile, session_id, request_id, method, json.dumps(payload, separators=(",", ":")), epoch))
            self.connection.commit()

    def approval(self, user: str, profile: str, session_id: str, request_id: str) -> dict[str, Any] | None:
        """Look up an approval request only inside its identity scope."""

        with self.lock:
            return self._row(self.connection.execute("SELECT * FROM codex_approvals WHERE user_id=? AND profile=? AND session_id=? AND request_id=?", (user, profile, session_id, request_id)).fetchone())

    def remove_approval(self, user: str, profile: str, session_id: str, request_id: str) -> None:
        """Remove an approval after sending its response upstream."""

        with self.lock:
            self.connection.execute("DELETE FROM codex_approvals WHERE user_id=? AND profile=? AND session_id=? AND request_id=?", (user, profile, session_id, request_id))
            self.connection.commit()

    def remove_approval_by_upstream_id(self, user: str, profile: str, session_id: str, epoch: str, upstream_id: Any) -> str | None:
        """Remove the current connection's approval identified by its raw JSON-RPC id."""

        with self.lock:
            rows = self.connection.execute(
                "SELECT request_id,payload FROM codex_approvals WHERE user_id=? AND profile=? AND session_id=? AND epoch=? AND state IN ('pending','sending','unknown')",
                (user, profile, session_id, epoch),
            ).fetchall()
            match: str | None = None
            for row in rows:
                try:
                    payload = json.loads(row["payload"])
                except (TypeError, json.JSONDecodeError):
                    continue
                if isinstance(payload, dict) and payload.get("id") == upstream_id:
                    match = str(row["request_id"])
                    break
            if match is None:
                return None
            self.connection.execute(
                "DELETE FROM codex_approvals WHERE user_id=? AND profile=? AND session_id=? AND request_id=? AND epoch=?",
                (user, profile, session_id, match, epoch),
            )
            self.connection.commit()
            return match

    def session_for_upstream_request(self, user: str, profile: str, epoch: str, upstream_id: Any) -> str | None:
        """Find the session owning a raw request id in the current connection epoch."""

        with self.lock:
            rows = self.connection.execute(
                "SELECT session_id,payload FROM codex_approvals WHERE user_id=? AND profile=? AND epoch=? AND state IN ('pending','sending','unknown')",
                (user, profile, epoch),
            ).fetchall()
            for row in rows:
                try:
                    payload = json.loads(row["payload"])
                except (TypeError, json.JSONDecodeError):
                    continue
                if isinstance(payload, dict) and payload.get("id") == upstream_id:
                    return str(row["session_id"])
        return None

    def remove_approvals_for_turn(self, user: str, profile: str, session_id: str, epoch: str, turn_id: str) -> list[str]:
        """Remove unresolved approvals belonging to one completed turn and epoch."""

        if not turn_id:
            return []
        with self.lock:
            rows = self.connection.execute(
                "SELECT request_id,payload FROM codex_approvals WHERE user_id=? AND profile=? AND session_id=? AND epoch=? AND state IN ('pending','sending','unknown')",
                (user, profile, session_id, epoch),
            ).fetchall()
            request_ids: list[str] = []
            for row in rows:
                try:
                    payload = json.loads(row["payload"])
                except (TypeError, json.JSONDecodeError):
                    continue
                params = payload.get("params", {}) if isinstance(payload, dict) else {}
                nested_turn = params.get("turn") if isinstance(params, dict) else None
                candidate = params.get("turnId") if isinstance(params, dict) else None
                if candidate is None and isinstance(nested_turn, dict):
                    candidate = nested_turn.get("id")
                if str(candidate or "") == turn_id:
                    request_ids.append(str(row["request_id"]))
            if request_ids:
                self.connection.executemany(
                    "DELETE FROM codex_approvals WHERE user_id=? AND profile=? AND session_id=? AND request_id=? AND epoch=?",
                    [(user, profile, session_id, request_id, epoch) for request_id in request_ids],
                )
                self.connection.commit()
            return request_ids

    def invalidate_approvals(self, user: str, profile: str, epoch: str) -> None:
        """Invalidate approvals owned by a prior Codex connection epoch."""

        with self.lock:
            self.connection.execute("UPDATE codex_approvals SET state='stale' WHERE user_id=? AND profile=? AND epoch<>? AND state IN ('pending','sending')", (user, profile, epoch))
            self.connection.commit()

    def claim_approval(self, user: str, profile: str, session_id: str, request_id: str, epoch: str) -> bool:
        """Atomically grant one client the right to answer an approval."""

        with self.lock:
            cursor = self.connection.execute("UPDATE codex_approvals SET state='sending' WHERE user_id=? AND profile=? AND session_id=? AND request_id=? AND epoch=? AND state='pending'", (user, profile, session_id, request_id, epoch))
            self.connection.commit()
        return cursor.rowcount == 1

    def mark_approval_unknown(self, user: str, profile: str, session_id: str, request_id: str) -> None:
        """Keep a sent approval locked when transport delivery is uncertain."""

        with self.lock:
            self.connection.execute("UPDATE codex_approvals SET state='unknown' WHERE user_id=? AND profile=? AND session_id=? AND request_id=?", (user, profile, session_id, request_id))
            self.connection.commit()

    def claim_completion(self, user: str, profile: str, session_id: str, turn_id: str) -> bool:
        """Claim one completion hook across live events and history recovery."""

        now = time.time()
        with self.lock:
            cursor = self.connection.execute("INSERT INTO codex_completion_hooks(user_id,profile,session_id,turn_id,claimed_at,completed) VALUES(?,?,?,?,?,0) ON CONFLICT(user_id,profile,session_id,turn_id) DO UPDATE SET claimed_at=excluded.claimed_at WHERE completed=0 AND claimed_at<?", (user, profile, session_id, turn_id, now, now - _COMPLETION_LEASE))
            self.connection.commit()
        return cursor.rowcount == 1

    def complete_completion(self, user: str, profile: str, session_id: str, turn_id: str) -> None:
        """Mark a successfully dispatched completion hook as durable."""

        with self.lock:
            self.connection.execute("UPDATE codex_completion_hooks SET completed=1 WHERE user_id=? AND profile=? AND session_id=? AND turn_id=?", (user, profile, session_id, turn_id))
            self.connection.commit()

    def release_completion(self, user: str, profile: str, session_id: str, turn_id: str) -> None:
        """Release a completion claim when its observer failed."""

        with self.lock:
            self.connection.execute("DELETE FROM codex_completion_hooks WHERE user_id=? AND profile=? AND session_id=? AND turn_id=?", (user, profile, session_id, turn_id))
            self.connection.commit()


def _safe(value: str, label: str) -> str:
    """Validate a user, profile, or session identifier before database use."""

    if not _IDENTIFIER.fullmatch(value):
        raise HTTPException(status_code=400, detail=f"Invalid {label}")
    return value


def _native_error_message(error: Any) -> str:
    """Keep a short, single-line native error for an actionable HTTP detail."""

    if not isinstance(error, dict):
        return ""
    message = str(error.get("message") or "").strip()
    return " ".join(message.split())[:240]


class CodexBridge:
    """Coordinate shared Codex connections in a single sidecar worker."""

    def __init__(
        self,
        db_path: Path | None = None,
        workspace_root: Path | None = None,
        endpoint: str | None = None,
        transport_factory: Callable[[str], Awaitable[JsonTransport] | JsonTransport] | None = None,
        request_timeout: float = _DEFAULT_TIMEOUT,
        workspace_map: dict[str, Any] | None = None,
        on_session_created: Callable[[dict[str, Any]], Any] | None = None,
        on_completed: Callable[[dict[str, Any]], Any] | None = None,
        attachment_store: AttachmentStore | None = None,
        permission_mode: str | None = None,
    ) -> None:
        """Configure the bridge without opening a Codex process until first use."""

        resolved_permission_mode = _resolve_permission_mode(permission_mode)
        configured_db = os.environ.get("HERMES_WORKBENCH_CODEX_DB") or os.environ.get("HERMES_WORKBENCH_RUNTIME_DB")
        self.store = BridgeStore(db_path or Path(configured_db or "/opt/data/.hermes-workbench/codex.sqlite3"))
        self.workspace_root = (workspace_root or Path(os.environ.get("HERMES_WORKBENCH_CODEX_WORKSPACES", "/opt/data/workspace"))).resolve()
        self.workspace_map = workspace_map if workspace_map is not None else self._load_workspace_map()
        self.endpoint = endpoint or os.environ.get("CODEX_APP_SERVER_ENDPOINT", "")
        self.request_timeout = request_timeout
        self.permission_mode = resolved_permission_mode
        self.transport_factory = transport_factory
        self.on_session_created = on_session_created
        self.on_completed = on_completed
        self.attachments = attachment_store or AttachmentStore()
        self._connections: dict[tuple[str, str], JsonRpcConnection] = {}
        self._subscribers: dict[tuple[str, str, str], set[asyncio.Queue[dict[str, Any]]]] = {}
        self._session_locks: dict[tuple[str, str, str], asyncio.Lock] = {}
        self._request_locks: dict[tuple[str, str, str, str], asyncio.Lock] = {}
        self._history_inflight: dict[tuple[Any, ...], asyncio.Task[dict[str, Any]]] = {}
        self._observer_tasks: set[asyncio.Task[Any]] = set()
        self._active_completions: set[tuple[str, str, str, str]] = set()
        self._connection_lock = asyncio.Lock()
        self._closing = False

    def _load_workspace_map(self) -> dict[str, Any]:
        """Read explicit profile workspace locations from configuration."""

        raw = os.environ.get("HERMES_WORKBENCH_CODEX_WORKSPACE_MAP", "")
        if not raw:
            return {}
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("HERMES_WORKBENCH_CODEX_WORKSPACE_MAP must be JSON") from exc
        return value if isinstance(value, dict) else {}

    def workspaces(self, profile: str, user: str = "") -> list[dict[str, Any]]:
        """Return configured workspace roots for one profile without creating paths."""

        profile = _safe(profile, "profile")
        if user:
            user = _safe(user, "user")
        configured = self.workspace_map.get(profile)
        if configured is None:
            configured = [{"id": "default", "name": profile, "path": str(self.workspace_root)}]
        if isinstance(configured, str):
            configured = [{"id": "default", "name": profile, "path": configured}]
        result: list[dict[str, Any]] = []
        if not isinstance(configured, list):
            raise HTTPException(status_code=500, detail="Invalid workspace configuration")
        for index, entry in enumerate(configured):
            if isinstance(entry, str):
                entry = {"path": entry}
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                raise HTTPException(status_code=500, detail="Invalid workspace configuration")
            path = Path(entry["path"]).expanduser().resolve()
            workspace_id = _safe(str(entry.get("id") or index), "workspace")
            result.append({"id": workspace_id, "name": str(entry.get("name") or path.name or workspace_id), "path": str(path), "profile": profile})
        return result

    def workspace(self, profile: str, user: str = "", workspace_id: str | None = None, cwd: str | None = None) -> dict[str, Any]:
        """Select and validate one configured workspace path."""

        entries = self.workspaces(profile, user)
        selected = next((entry for entry in entries if workspace_id and entry["id"] == workspace_id), None) if workspace_id else entries[0]
        if selected is None:
            raise HTTPException(status_code=400, detail="Unknown workspace")
        if cwd:
            candidate = Path(cwd).expanduser().resolve()
            try:
                candidate.relative_to(Path(selected["path"]))
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="cwd is outside the selected workspace") from exc
            selected = {**selected, "path": str(candidate)}
        return selected

    def create_group(self, user: str, profile: str, name: str) -> dict[str, Any]:
        """Create a user-scoped logical group independently of execution directories."""

        normalized = name.strip()
        if not 1 <= len(normalized) <= 60:
            raise HTTPException(status_code=400, detail="Group name must contain 1 to 60 characters")
        return self.store.create_group(user, profile, "", "", normalized)

    def rename_group(self, user: str, profile: str, group_id: str, name: str) -> dict[str, Any]:
        """Validate a group name and rename one identity-scoped group."""

        normalized = name.strip()
        if not 1 <= len(normalized) <= 60:
            raise HTTPException(status_code=400, detail="Group name must contain 1 to 60 characters")
        return self.store.rename_group(user, profile, group_id, normalized)

    async def update_organization(self, user: str, profile: str, session_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Serialize organization changes with submissions for one session."""

        if any(values.get(key) is None for key in ("favorite", "deleted") if key in values):
            raise HTTPException(status_code=400, detail="favorite and deleted must be boolean values")
        lock = self._session_locks.setdefault((user, profile, session_id), asyncio.Lock())
        async with lock:
            return await asyncio.to_thread(self.store.update_organization, user, profile, session_id, values)

    async def _connection(self, user: str, profile: str) -> JsonRpcConnection:
        """Return one shared app-server connection for an identity and profile."""

        key = (user, profile)
        async with self._connection_lock:
            if self._closing:
                raise UnknownAcceptance("Codex bridge is shutting down")
            existing = self._connections.get(key)
            reconnecting = existing is not None and existing.closed
            if existing is not None:
                if not existing.closed:
                    return existing
                await existing.close()
                self._connections.pop(key, None)
            if self.transport_factory is not None:
                value = self.transport_factory(self.endpoint)
                transport = await value if inspect.isawaitable(value) else value
            elif self.endpoint.startswith(("ws://", "wss://")):
                transport = await WebSocketJsonTransport.connect(self.endpoint)
            elif self.endpoint.startswith("unix://"):
                transport = await UnixJsonTransport.connect(self.endpoint.removeprefix("unix://"))
            elif self.endpoint:
                transport = await UnixJsonTransport.connect(self.endpoint)
            else:
                raise HTTPException(status_code=503, detail="Codex app-server endpoint is not configured")
            epoch = uuid.uuid4().hex
            connection = JsonRpcConnection(
                transport,
                lambda message, current_epoch=epoch: self._notification(user, profile, current_epoch, message),
                self.request_timeout,
                epoch=epoch,
                on_notification_batch=lambda messages, current_epoch=epoch: self._notification_batch(user, profile, current_epoch, messages),
            )
            try:
                await connection.start()
            except Exception:
                await connection.close()
                raise
            self._connections[key] = connection
            self.store.invalidate_approvals(user, profile, epoch)
            for session in self.store.all_sessions(user, profile):
                # Completed history is loaded on demand by history(); eagerly
                # resuming it spawns MCP workers for every archived conversation.
                if session.get("status") not in {"running", "waiting", "unknown"}:
                    continue
                if str(session["thread_id"]).startswith("pending:"):
                    continue
                if connection.closed:
                    raise UnknownAcceptance("Codex connection closed during thread recovery")
                resume_params = {
                    "threadId": session["thread_id"],
                    "includeTurns": False,
                }
                resume_params.update(_thread_permission_params(self.permission_mode))
                with contextlib.suppress(RpcFailure):
                    await connection.request("thread/resume", resume_params)
            if reconnecting:
                task = asyncio.create_task(self._recover_sessions(user, profile))
                self._observer_tasks.add(task)
                task.add_done_callback(self._observer_tasks.discard)
            return connection

    async def _recover_sessions(self, user: str, profile: str) -> None:
        """Reconcile completed turns after reconnect without replaying requests."""

        for session in self.store.all_sessions(user, profile):
            if session.get("status") not in {"running", "waiting", "unknown"}:
                continue
            if str(session["thread_id"]).startswith("pending:"):
                continue
            with contextlib.suppress(HTTPException, RpcFailure, UnknownAcceptance):
                await self.history(user, profile, session["session_id"], 0, _MAX_PAGE)

    async def close(self) -> None:
        """Close all shared Codex connections during sidecar shutdown."""

        self._closing = True
        async with self._connection_lock:
            connections = tuple(self._connections.values())
            self._connections.clear()
        await asyncio.gather(*(connection.close() for connection in connections), return_exceptions=True)
        # Closing a connection can deliver a final completed notification and
        # schedule its observer.  Wait only after every connection has drained,
        # so no observer can touch SQLite after the store closes.
        while self._observer_tasks:
            await asyncio.gather(*tuple(self._observer_tasks), return_exceptions=True)
        self.store.close()

    def _notification_context(
        self,
        user: str,
        profile: str,
        epoch: str,
        message: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Resolve one upstream message to its identity-scoped persistence data."""

        params_value = message.get("params")
        params = params_value if isinstance(params_value, dict) else {}
        method = str(message.get("method"))
        thread_value = params.get("thread")
        goal_value = params.get("goal")
        thread_id = str(
            params.get("threadId")
            or (thread_value.get("id") if isinstance(thread_value, dict) else "")
            or (goal_value.get("threadId") if isinstance(goal_value, dict) else "")
            or ""
        )
        session = self.store.session_by_thread(user, profile, thread_id) if thread_id else None
        if session is None and method == "serverRequest/resolved" and params.get("requestId") is not None:
            # Current Codex schemas include threadId.  Keep a precise epoch
            # lookup for older adapters that omitted it from this notification.
            owner_id = self.store.session_for_upstream_request(user, profile, epoch, params["requestId"])
            session = self.store.session(user, profile, owner_id) if owner_id else None
        if session is None:
            return None
        event_message = message
        opaque_id: str | None = None
        if "id" in message:
            # JSON-RPC messages with both ``method`` and ``id`` are upstream
            # server requests.  Add only the opaque browser id to the event;
            # the untouched message remains the response source.
            opaque_id = f"{epoch}:{message['id']}"
            event_message = {**message, "params": {**params, "approvalId": opaque_id}}
        return {
            "user": user,
            "profile": profile,
            "epoch": epoch,
            "message": message,
            "params": params,
            "method": method,
            "session": session,
            "event_message": event_message,
            "opaque_id": opaque_id,
        }

    def _persist_notification_batch(
        self,
        user: str,
        profile: str,
        epoch: str,
        messages: list[dict[str, Any]],
    ) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """Route and commit a FIFO notification batch on a worker thread."""

        contexts: list[dict[str, Any]] = []
        entries: list[tuple[str, str, str, str, dict[str, Any]]] = []
        for message in messages:
            context = self._notification_context(user, profile, epoch, message)
            if context is None:
                continue
            session = context["session"]
            contexts.append(context)
            entries.append((user, profile, str(session["session_id"]), str(context["method"]), context["event_message"]))
        events = self.store.append_events(entries)
        return list(zip(contexts, events))

    async def _notification_batch(self, user: str, profile: str, epoch: str, messages: list[dict[str, Any]]) -> None:
        """Commit a queued batch before applying side effects and broadcasting."""

        persisted = await asyncio.to_thread(self._persist_notification_batch, user, profile, epoch, messages)
        for context, event in persisted:
            await self._deliver_notification(context, event)

    async def _deliver_notification(self, context: dict[str, Any], event: dict[str, Any]) -> None:
        """Apply event-specific durable state and publish one committed event."""

        user = str(context["user"])
        profile = str(context["profile"])
        epoch = str(context["epoch"])
        message = context["message"]
        params = context["params"]
        method = str(context["method"])
        session_id = str(context["session"]["session_id"])
        # A batch may contain lifecycle events for the same session.  Resolve
        # the current row for each event so a started event cannot leave a
        # following completed event stuck with the batch's initial status.
        session = self.store.session(user, profile, session_id) or context["session"]
        opaque_id = context["opaque_id"]
        if method in {"turn/started", "turn/completed"}:
            # Earlier events in this batch may already have changed this session.
            session = self.store.session(user, profile, session_id) or session
        if opaque_id is not None:
            # Persist unknown request schemas too, so the browser can show
            # them as native-terminal-only rather than guess a response.
            self.store.save_approval(user, profile, session_id, opaque_id, method, message, epoch)
        if method == "serverRequest/resolved":
            # Resolve only the epoch that received the request, so a reused
            # raw JSON-RPC id on a later connection cannot remove it.
            self.store.remove_approval_by_upstream_id(user, profile, session_id, epoch, params.get("requestId"))
        elif method == "turn/completed":
            turn_value = params.get("turn")
            turn_id = turn_value.get("id") if isinstance(turn_value, dict) else None
            turn_status = turn_value.get("status") if isinstance(turn_value, dict) else "completed"
            next_status = turn_status or "completed"
            if session.get("status") != next_status:
                session = self.store.upsert_session(user, profile, {**session, "status": next_status})
            self.store.remove_approvals_for_turn(user, profile, session_id, epoch, str(turn_id or params.get("turnId") or ""))
            if turn_status in (None, "completed"):
                await self._schedule_completion(session, event, str(turn_id or params.get("turnId") or ""))
        elif method == "turn/started":
            if session.get("status") != "running":
                self.store.upsert_session(user, profile, {**session, "status": "running"})
        for queue in tuple(self._subscribers.get((user, profile, session_id), ())):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # A lagging client must re-read the authoritative snapshot;
                # dropping an event would make its cursor unverifiable.
                while not queue.empty():
                    with contextlib.suppress(asyncio.QueueEmpty):
                        queue.get_nowait()
                queue.put_nowait({"seq": event["seq"], "type": "resync_required"})

    async def _notification(self, user: str, profile: str, epoch: str | dict[str, Any], message: dict[str, Any] | None = None) -> None:
        """Persist one notification immediately for direct callers and tests."""

        if message is None:
            raw_message = epoch if isinstance(epoch, dict) else {}
            current = self._connections.get((user, profile))
            current_epoch = current.epoch if current is not None else ""
        else:
            raw_message = message
            current_epoch = str(epoch)
        context = self._notification_context(user, profile, current_epoch, raw_message)
        if context is None:
            return
        session = context["session"]
        event = self.store.append_event(user, profile, str(session["session_id"]), str(context["method"]), context["event_message"])
        await self._deliver_notification(context, event)

    async def _schedule_completion(self, session: dict[str, Any], event: dict[str, Any], turn_id: str) -> None:
        """Schedule one idempotent completion observer for a live or recovered turn."""

        if self.on_completed is None or not turn_id:
            return
        key = (session["user_id"], session["profile"], session["session_id"], turn_id)
        if key in self._active_completions or not self.store.claim_completion(*key):
            return
        self._active_completions.add(key)

        async def invoke() -> None:
            """Run the observer and release its claim when it fails."""

            try:
                result = self.on_completed({**session, "event": event})
                if inspect.isawaitable(result):
                    await result
                self.store.complete_completion(session["user_id"], session["profile"], session["session_id"], turn_id)
            except Exception:
                self.store.release_completion(*key)
            finally:
                self._active_completions.discard(key)

        task = asyncio.create_task(invoke())
        self._observer_tasks.add(task)
        task.add_done_callback(self._observer_tasks.discard)

    async def create_session(self, user: str, profile: str, values: dict[str, Any]) -> dict[str, Any]:
        """Create a Codex thread and persist its Workbench session mapping."""

        profile = _safe(profile, "profile")
        session_id = str(values.get("session_id") or uuid.uuid4())
        session_id = _safe(session_id, "session")
        lock = self._session_locks.setdefault((user, profile, session_id), asyncio.Lock())
        async with lock:
            existing = self.store.session(user, profile, session_id)
            if existing is not None and existing.get("deleted"):
                raise HTTPException(status_code=410, detail="Restore the archived session before creating its thread")
            if existing is not None and not str(existing["thread_id"]).startswith("pending:"):
                return existing
            workspace = self.workspace(profile, user, str(values.get("workspace_id") or values.get("workspaceId") or "") or None, values.get("cwd"))
            pending = existing or {"session_id": session_id, "thread_id": f"pending:{session_id}", "workspace_id": workspace["id"], "workspace_path": workspace["path"], "status": "starting", "title": str(values.get("title") or "")[:80]}
            value = await self._initialize_session(user, profile, pending, values)
        return value

    async def _initialize_session(self, user: str, profile: str, pending: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
        """Resolve a placeholder under its session lock, before any turn can be sent.

        An uncertain thread/start may leave an empty upstream thread. Retrying
        creates a fresh empty thread; it never replays a possibly accepted turn.
        """
        pending = self.store.upsert_session(user, profile, {**pending, "status": "starting"})
        params: dict[str, Any] = {
            "cwd": pending["workspace_path"],
            "approvalPolicy": values.get("approvalPolicy"),
            # Codex app-server does not receive Hermes' native system prompt.
            # Give every new thread the compact memory index and let Codex
            # read only the relevant topic file when the task needs it.
            "developerInstructions": build_codex_memory_instructions(),
        }
        for key in ("model", "sandbox", "serviceTier", "personality", "reasoningEffort"):
            if values.get(key) is not None:
                params[key] = values[key]
        if values.get("effort") is not None and "reasoningEffort" not in params:
            params["reasoningEffort"] = values["effort"]
        params.update(_thread_permission_params(self.permission_mode))
        try:
            connection = await self._connection(user, profile)
            response = await connection.request("thread/start", params)
            thread = response.get("thread") if isinstance(response.get("thread"), dict) else response
            thread_id = str(thread.get("id") or "")
            if not thread_id or thread_id.startswith("pending:"):
                raise HTTPException(status_code=502, detail="Codex did not return a valid thread id; retry creating the session")
        except asyncio.CancelledError:
            self.store.upsert_session(user, profile, {**pending, "status": "unknown"})
            raise
        except (RpcFailure, HTTPException) as exc:
            self.store.upsert_session(user, profile, {**pending, "status": "failed"})
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(status_code=502, detail="Codex session creation failed; retry creating the session") from exc
        except (UnknownAcceptance, OSError, RuntimeError) as exc:
            self.store.upsert_session(user, profile, {**pending, "status": "unknown"})
            raise HTTPException(status_code=503, detail="Codex session creation was not confirmed; retry creating the session") from exc
        value = self.store.upsert_session(user, profile, {**pending, "thread_id": thread_id, "status": "idle"})
        if self.on_session_created is not None:
            try:
                result = self.on_session_created(value)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                # Codex history already exists. Keep it usable and expose a
                # recoverable integration state so the tmux hook can retry.
                value = self.store.upsert_session(user, profile, {**value, "status": "recoverable"})
        return value

    async def submit(self, user: str, profile: str, session_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Serialize one client request id so concurrent retries send once."""

        session_lock = self._session_locks.setdefault((user, profile, session_id), asyncio.Lock())
        async with session_lock:
            existing = self.store.session(user, profile, session_id)
            if existing is None:
                raise HTTPException(status_code=404, detail="Session not found")
            if existing.get("deleted"):
                raise HTTPException(status_code=410, detail="Restore the archived session before sending a message")
            if str(existing["thread_id"]).startswith("pending:"):
                if values.get("expectedTurnId") is not None:
                    raise HTTPException(status_code=409, detail="Session has no active thread to steer")
                await self._initialize_session(user, profile, existing, values)
            client_id = _safe(str(values.get("clientRequestId") or ""), "clientRequestId")
            lock = self._request_locks.setdefault((user, profile, session_id, client_id), asyncio.Lock())
            async with lock:
                return await self._submit_once(user, profile, session_id, values)

    async def _submit_once(self, user: str, profile: str, session_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Submit one turn exactly once per client request id when acceptance is known."""

        session = self.store.session(user, profile, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        if session.get("deleted"):
            raise HTTPException(status_code=410, detail="Restore the archived session before sending a message")
        client_id = _safe(str(values.get("clientRequestId") or ""), "clientRequestId")
        previous = self.store.request(user, profile, session_id, client_id)
        if previous is not None:
            # Only the old placeholder-ID rejection is safe to retry. Never
            # replay an accepted or uncertain turn, even after reconnecting.
            if not _rejected_placeholder_request(previous):
                return previous
        title_text = str(values.get("text") or "")
        attachment_ids = values.get("attachmentIds")
        if attachment_ids is None:
            attachment_ids = values.get("attachment_ids")
        attachment_input = self.attachments.resolve_inputs(
            Path(str(session["workspace_path"])),
            user,
            profile,
            session_id,
            attachment_ids,
        )
        raw_input = values.get("input")
        if raw_input:
            input_items = list(raw_input)
        else:
            input_items = [{"type": "text", "text": str(values.get("text") or "")}]
        if not title_text and isinstance(raw_input, list) and raw_input:
            first_input = raw_input[0]
            if isinstance(first_input, dict):
                title_text = str(first_input.get("text") or "")
        if attachment_input:
            if any(
                isinstance(item, dict) and item.get("type") == "localImage"
                for item in input_items
            ):
                raise HTTPException(status_code=400, detail="localImage input must come from an uploaded attachment")
            input_items.extend(attachment_input)
        self.store.set_title_if_empty(user, profile, session_id, title_text)
        payload = {"input": input_items, "threadId": session["thread_id"], "clientUserMessageId": client_id}
        expected_turn_id = values.get("expectedTurnId")
        method = "turn/steer" if expected_turn_id is not None else "turn/start"
        if expected_turn_id is not None:
            # Bind input to the observed active turn; never silently start another turn.
            payload["expectedTurnId"] = _safe(str(expected_turn_id), "expectedTurnId")
        else:
            for key in ("model", "effort", "serviceTier", "approvalPolicy", "approvalsReviewer"):
                if values.get(key) is not None:
                    payload[key] = values[key]
            payload.update(_turn_permission_params(self.permission_mode))
        self.store.save_request(user, profile, session_id, client_id, status="pending", payload=json.dumps(payload))
        connection = await self._connection(user, profile)
        try:
            try:
                response = await connection.request(method, payload)
            except RpcFailure as exc:
                # Reading persisted history does not load a thread after a
                # runtime restart. Retry only this explicit pre-acceptance
                # rejection, once; never replay a steer or uncertain send.
                error = exc.error if isinstance(exc.error, dict) else {}
                if (
                    method != "turn/start"
                    or error.get("code") != -32600
                    or error.get("message") != f"thread not found: {session['thread_id']}"
                ):
                    raise
                resume_params = {"threadId": session["thread_id"], "includeTurns": False}
                resume_params.update(_thread_permission_params(self.permission_mode))
                await connection.request("thread/resume", resume_params)
                response = await connection.request(method, payload)
        except UnknownAcceptance:
            return self.store.save_request(user, profile, session_id, client_id, status="unknown")
        except RpcFailure as exc:
            return self.store.save_request(user, profile, session_id, client_id, status="failed", result=json.dumps(exc.error))
        turn = response.get("turn") if isinstance(response.get("turn"), dict) else {}
        turn_id = response.get("turnId") if expected_turn_id is not None else turn.get("id")
        result = self.store.save_request(user, profile, session_id, client_id, status="accepted", turn_id=turn_id, result=json.dumps(response))
        turn_status = str(turn.get("status") or "").lower()
        if turn_status not in {"completed", "failed", "interrupted"}:
            await asyncio.to_thread(self.store.mark_submission_running, user, profile, session_id, str(turn_id or ""))
        return result

    def _native_thread_is_known_empty(
        self,
        session: dict[str, Any],
        thread: dict[str, Any],
    ) -> bool:
        """Accept an unsupported native history list only for a fresh empty thread.

        The app-server currently returns an unsupported-method error for both
        embedded turns and the paginated turns endpoint on a newly created
        thread.  The metadata returned by ``thread/read`` is only a supporting
        signal: an empty preview and valid creation/update timestamps
        must be paired with this bridge's evidence that no client
        turn was submitted and no native activity beyond thread creation was
        persisted.  We keep the upstream failure visible for every other case.
        """

        if thread.get("preview") != "":
            return False
        status = thread.get("status")
        if not isinstance(status, dict) or status.get("type") not in {"idle", "notLoaded"}:
            return False
        timestamps = tuple(thread.get(key) for key in ("createdAt", "updatedAt", "recencyAt"))
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in timestamps):
            return False
        # Starting MCP servers can advance updatedAt/recencyAt before any turn.
        if any(value < timestamps[0] for value in timestamps[1:]):
            return False
        if self.store.has_submission(session["user_id"], session["profile"], session["session_id"]):
            return False
        if self.store.has_non_thread_event(session["user_id"], session["profile"], session["session_id"]):
            return False
        # A mapped session with a non-default status has already observed a
        # lifecycle transition, so its native history cannot be assumed empty.
        return str(session.get("status") or "idle") == "idle"

    async def history(self, user: str, profile: str, session_id: str, after: int, limit: int, *, defer_persistence: bool = False) -> dict[str, Any]:
        """Share concurrent HTTP/WebSocket reads without retaining stale snapshots."""
        key = (user, profile, session_id, after, limit, defer_persistence)
        task = self._history_inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._read_history(user, profile, session_id, after, limit, defer_persistence=defer_persistence))
            self._history_inflight[key] = task
            self._observer_tasks.add(task)
            def finished(done: asyncio.Task[Any]) -> None:
                if self._history_inflight.get(key) is done:
                    self._history_inflight.pop(key, None)
                self._observer_tasks.discard(done)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def history_preview(self, user: str, profile: str, session_id: str, limit: int = _PREVIEW_TURN_LIMIT) -> dict[str, Any]:
        """Return a local recent-turn preview without contacting Codex upstream."""

        session = self.store.session(user, profile, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        if session.get("deleted"):
            raise HTTPException(status_code=410, detail="Restore the archived session before reading its history")
        if str(session["thread_id"]).startswith("pending:"):
            return {
                "session": session,
                "turns": [],
                "events": [],
                "snapshotEvents": [],
                "snapshotSeq": 0,
                "pendingApprovals": [],
                "pendingRequests": self.store.pending_requests(user, profile, session_id),
                "next": 0,
                "hasMore": False,
                "readSeq": self.store.read_progress(user, profile, session_id),
                "cached": True,
            }
        preview = await asyncio.to_thread(self.store.cached_history_preview, user, profile, session_id, limit)
        if preview is None:
            raise HTTPException(status_code=404, detail="No cached history preview")
        terminal_turns = {
            str(turn.get("id"))
            for turn in preview["turns"]
            if turn.get("status") in ("completed", "failed", "interrupted")
        }
        pending_approvals = [
            approval
            for approval in self.store.pending_approvals(user, profile, session_id)
            if str(approval.get("params", {}).get("turnId")) not in terminal_turns
        ]
        return {
            "session": session,
            "turns": preview["turns"],
            "events": [],
            "snapshotEvents": [],
            "snapshotSeq": preview["snapshotSeq"],
            "pendingApprovals": pending_approvals,
            "pendingRequests": self.store.pending_requests(user, profile, session_id),
            "next": preview["snapshotSeq"],
            "hasMore": False,
            "readSeq": self.store.read_progress(user, profile, session_id),
            "cached": True,
        }

    async def _persist_history(self, session: dict[str, Any], connection: JsonRpcConnection, turns: list[dict[str, Any]], entries: list[Any], marker_indexes: list[int]) -> None:
        """Archive authoritative history durably, independently of first paint."""
        user, profile, session_id = session["user_id"], session["profile"], session["session_id"]
        markers = await asyncio.to_thread(self.store.append_events, entries)
        for turn, marker_index in zip(turns, marker_indexes):
            marker = markers[marker_index]
            turn_id = str(turn.get("id") or "")
            if turn.get("status") in ("completed", "failed", "interrupted"):
                self.store.remove_approvals_for_turn(user, profile, session_id, connection.epoch, turn_id)
            if turn.get("status") == "completed":
                await self._schedule_completion(session, marker, turn_id)
            for item in turn.get("items", []):
                if isinstance(item, dict) and item.get("type") == "userMessage" and item.get("clientId"):
                    self.store.reconcile_request(user, profile, session_id, str(item["clientId"]), turn_id)

    async def _read_thread_history(self, session: dict[str, Any], connection: JsonRpcConnection) -> dict[str, Any]:
        """Read a thread, reloading an idle native session once when needed.

        The app-server can unload an inactive thread while this bridge's
        WebSocket remains alive.  Its rollout is still on disk, but the first
        ``thread/read`` then fails.  A single ``thread/resume`` restores that
        normal idle state without sending or replaying a user turn.
        """

        read_params = {"threadId": session["thread_id"], "includeTurns": True}
        try:
            return await connection.request("thread/read", read_params)
        except RpcFailure as first_error:
            # Keep the existing compatibility fallback for runtimes that do
            # not support embedded turns on thread/read.
            if isinstance(first_error.error, dict) and first_error.error.get("code") == -32601:
                raise
            resume_params = {"threadId": session["thread_id"], "includeTurns": False}
            resume_params.update(_thread_permission_params(self.permission_mode))
            try:
                await connection.request("thread/resume", resume_params)
                return await connection.request("thread/read", read_params)
            except RpcFailure:
                raise first_error

    async def _read_history(self, user: str, profile: str, session_id: str, after: int, limit: int, *, defer_persistence: bool = False) -> dict[str, Any]:
        """Read canonical turns; browser snapshots need not wait for archive fsync."""
        session = self.store.session(user, profile, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        if session.get("deleted"):
            raise HTTPException(status_code=410, detail="Restore the archived session before reading its history")
        if str(session["thread_id"]).startswith("pending:"):
            # Keep failed messages visible and retryable without issuing an
            # invalid thread/read or turning a read into thread creation.
            return {"session": session, "turns": [], "events": [], "snapshotEvents": [], "snapshotSeq": 0,
                    "pendingApprovals": [], "pendingRequests": self.store.pending_requests(user, profile, session_id),
                    "next": after, "hasMore": False, "readSeq": self.store.read_progress(user, profile, session_id)}
        events = self.store.events(user, profile, session_id, after, limit)
        snapshot_start = self.store.event_highwater(user, profile, session_id)
        # A newly created thread has no native history to read.  Some
        # app-server versions reject both history methods until the first
        # user turn exists, so do not open the upstream read path at all for
        # this local, pristine state.  The first submit will create the turn;
        # subsequent snapshots will use the normal native history path.
        if (
            str(session.get("status") or "idle") == "idle"
            and not self.store.has_submission(user, profile, session_id)
            and not self.store.has_non_thread_event(user, profile, session_id)
        ):
            snapshot_seq = self.store.event_highwater(user, profile, session_id)
            visible_events = [event for event in events if not event["method"].startswith("history/")]
            return {
                "session": session,
                "turns": [],
                "events": visible_events,
                "snapshotEvents": [],
                "snapshotSeq": snapshot_seq,
                "pendingApprovals": self.store.pending_approvals(user, profile, session_id),
                "pendingRequests": self.store.pending_requests(user, profile, session_id),
                "next": visible_events[-1]["seq"] if visible_events else after,
                "hasMore": len(events) >= limit,
                "readSeq": self.store.read_progress(user, profile, session_id),
            }
        try:
            connection = await self._connection(user, profile)
        except (UnknownAcceptance, OSError, RuntimeError) as exc:
            raise HTTPException(status_code=503, detail="Codex history is temporarily unavailable") from exc
        current_status: str | None = None
        canonical_turns: list[dict[str, Any]] = []
        history_entries: list[tuple[str, str, str, str, dict[str, Any]]] = []
        marker_indexes: list[int] = []
        try:
            try:
                response = await self._read_thread_history(session, connection)
            except RpcFailure as exc:
                # Some native runtimes reject embedded turns before the first message.
                # Read metadata before checking their separate history endpoint.
                if not isinstance(exc.error, dict) or exc.error.get("code") != -32601:
                    raise
                response = await connection.request("thread/read", {"threadId": session["thread_id"], "includeTurns": False})
            thread = response.get("thread") if isinstance(response.get("thread"), dict) else response
            turns = thread.get("turns", []) if isinstance(thread, dict) else []
            if not turns:
                turns = []
                cursor: str | None = None
                for _ in range(_MAX_HISTORY_PAGES):
                    try:
                        page = await connection.request("thread/turns/list", {"threadId": session["thread_id"], "itemsView": "full", "limit": _MAX_PAGE, "sortDirection": "asc", "cursor": cursor})
                    except RpcFailure as exc:
                        # A fresh empty thread is the only case where both
                        # native history methods may be unsupported.  Preserve
                        # the failure for any thread with weaker evidence.
                        error = exc.error if isinstance(exc.error, dict) else {}
                        message = str(error.get("message") or "")
                        unsupported_before_first_message = (
                            (error.get("code") == -32601 and "list_turns" in message)
                            or (
                                error.get("code") == -32600
                                and "thread/turns/list is unavailable before first user message" in message
                            )
                        )
                        if (
                            not unsupported_before_first_message
                            or turns
                            or cursor is not None
                            or not isinstance(thread, dict)
                            or (
                                not self._native_thread_is_known_empty(session, thread)
                                and (
                                    self.store.has_submission(session["user_id"], session["profile"], session["session_id"])
                                    or self.store.has_non_thread_event(session["user_id"], session["profile"], session["session_id"])
                                )
                            )
                        ):
                            raise
                        break
                    turns.extend(page.get("data", []))
                    cursor = page.get("nextCursor")
                    if not cursor:
                        break
                if cursor:
                    raise HTTPException(status_code=502, detail="Codex turn history pagination did not terminate")
            for turn in turns:
                if isinstance(turn, dict):
                    if turn.get("itemsView") != "full" or "items" not in turn:
                        items: list[dict[str, Any]] = []
                        cursor = None
                        for _ in range(_MAX_HISTORY_PAGES):
                            items_page = await connection.request("thread/items/list", {"threadId": session["thread_id"], "turnId": turn.get("id"), "limit": _MAX_PAGE, "sortDirection": "asc", "cursor": cursor})
                            for entry in items_page.get("data", []):
                                if isinstance(entry, dict) and isinstance(entry.get("item"), dict):
                                    items.append(entry["item"])
                            cursor = items_page.get("nextCursor")
                            if not cursor:
                                break
                        if cursor:
                            raise HTTPException(status_code=502, detail="Codex item history pagination did not terminate")
                        turn = {**turn, "items": items, "itemsView": "full"}
                    canonical_turns.append(turn)
                    items = turn.get("items", [])
                    if items:
                        for item in items:
                            if isinstance(item, dict):
                                history_entries.append((user, profile, session_id, "history/item", {"method": "history/item", "params": {"threadId": session["thread_id"], "turnId": turn.get("id"), "item": item}}))
                    marker_method = "history/turn" if turn.get("status") == "completed" else "history/turn-status"
                    marker_indexes.append(len(history_entries))
                    history_entries.append((user, profile, session_id, marker_method, {"method": marker_method, "params": {"threadId": session["thread_id"], "turn": {**turn, "items": []}}}))
            for turn in canonical_turns:
                status = turn.get("status")
                if status in ("completed", "failed", "interrupted", "inProgress"):
                    current_status = "running" if status == "inProgress" else status
            if not defer_persistence:
                await self._persist_history(session, connection, canonical_turns, history_entries, marker_indexes)
        except (RpcFailure, UnknownAcceptance, OSError, RuntimeError) as exc:
            raise HTTPException(status_code=503, detail="Codex history is temporarily unavailable") from exc
        # Responses can arrive while earlier notifications await durable storage.
        # Include those notifications before publishing the snapshot cursor.
        try:
            await connection.drain_notifications()
        except UnknownAcceptance as exc:
            raise HTTPException(status_code=503, detail="Codex history is temporarily unavailable") from exc
        latest_live = self.store.latest_live_status(user, profile, session_id, snapshot_start)
        if latest_live is not None:
            current_status = latest_live
        if current_status is not None and current_status != session.get("status"):
            session = self.store.upsert_session(user, profile, {**session, "status": current_status})
        session = self.store.session(user, profile, session_id) or session
        snapshot_seq = self.store.event_highwater(user, profile, session_id)
        # Canonical turns already include archived history; replay only racing live events.
        snapshot_events = [event for event in self.store.events_between(user, profile, session_id, snapshot_start, snapshot_seq) if not event["method"].startswith("history/")]
        all_events = self.store.events(user, profile, session_id, after, limit)
        events = [event for event in all_events if not event["method"].startswith("history/")]
        cursor = all_events[-1]["seq"] if all_events else after
        terminal_turns = {str(turn.get("id")) for turn in canonical_turns if turn.get("status") in ("completed", "failed", "interrupted")}
        pending_approvals = [approval for approval in self.store.pending_approvals(user, profile, session_id) if str(approval.get("params", {}).get("turnId")) not in terminal_turns]
        result = {"session": session, "turns": canonical_turns, "events": events, "snapshotEvents": snapshot_events, "snapshotSeq": snapshot_seq, "pendingApprovals": pending_approvals, "pendingRequests": self.store.pending_requests(user, profile, session_id), "next": cursor, "hasMore": len(all_events) >= limit, "readSeq": self.store.read_progress(user, profile, session_id)}
        if defer_persistence and history_entries:
            task = asyncio.create_task(self._persist_history(session, connection, canonical_turns, history_entries, marker_indexes))
            self._observer_tasks.add(task)
            def archive_done(done: asyncio.Task[Any]) -> None:
                self._observer_tasks.discard(done)
                if not done.cancelled() and done.exception() is not None:
                    error = done.exception()
                    logging.getLogger(__name__).error("Background history archival failed; next read will retry", exc_info=(type(error), error, error.__traceback__))
            task.add_done_callback(archive_done)
        return result


    async def models(self, user: str, profile: str) -> dict[str, Any]:
        """Read model choices from the connected Codex service."""

        response = await (await self._connection(user, profile)).request("model/list", {})
        return response

    async def _goal_request(
        self,
        user: str,
        profile: str,
        session_id: str,
        method: str,
        values: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Call one native goal RPC while serializing changes with session turns."""

        lock = self._session_locks.setdefault((user, profile, session_id), asyncio.Lock())
        async with lock:
            session = self.store.session(user, profile, session_id)
            if session is None:
                raise HTTPException(status_code=404, detail="Session not found")
            if session.get("deleted"):
                action = "reading" if method == "thread/goal/get" else "changing"
                raise HTTPException(status_code=410, detail=f"Restore the archived session before {action} its goal")
            if str(session["thread_id"]).startswith("pending:"):
                raise HTTPException(status_code=409, detail="Create the session thread before using goals")
            params = {"threadId": session["thread_id"]}
            if values:
                params.update({key: values[key] for key in ("objective", "status", "tokenBudget") if key in values})
            connection = await self._connection(user, profile)
            try:
                return await connection.request(method, params)
            except UnknownAcceptance as exc:
                raise HTTPException(status_code=503, detail="Codex goal request status is unknown; refresh the session") from exc
            except RpcFailure as exc:
                error = exc.error if isinstance(exc.error, dict) else {}
                message = _native_error_message(error)
                if "ephemeral thread" in message.lower():
                    detail = "Goals require a persistent Codex session"
                    if message:
                        detail = f"{detail}: {message}"
                    raise HTTPException(status_code=409, detail=detail) from exc
                detail = "Codex goal request failed"
                if message:
                    detail = f"{detail}: {message}"
                raise HTTPException(status_code=502, detail=detail) from exc

    async def get_goal(self, user: str, profile: str, session_id: str) -> dict[str, Any]:
        """Return the native goal, including ``null`` when the session has none."""

        response = await self._goal_request(user, profile, session_id, "thread/goal/get")
        return {"goal": response.get("goal")}

    async def set_goal(self, user: str, profile: str, session_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Persist one native goal update and leave continuation behavior to Codex."""

        objective = values.get("objective")
        if objective is not None and not str(objective).strip():
            raise HTTPException(status_code=400, detail="Goal objective must not be empty")
        status = values.get("status")
        if status is not None and status not in _GOAL_STATUSES:
            raise HTTPException(status_code=400, detail="Invalid goal status")
        response = await self._goal_request(user, profile, session_id, "thread/goal/set", values)
        return {"goal": response.get("goal")}

    async def clear_goal(self, user: str, profile: str, session_id: str) -> dict[str, Any]:
        """Clear the native goal and return Codex's ``cleared`` result."""

        response = await self._goal_request(user, profile, session_id, "thread/goal/clear")
        return {"cleared": bool(response.get("cleared"))}

    async def control(self, user: str, profile: str, session_id: str, action: str, values: dict[str, Any]) -> dict[str, Any]:
        """Apply an approval or stop action using the upstream method for it."""

        session = self.store.session(user, profile, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        if str(session["thread_id"]).startswith("pending:"):
            raise HTTPException(status_code=409, detail="Session has no active thread to control")
        connection = await self._connection(user, profile)
        if action == "stop":
            turn_id = str(values.get("turnId") or "")
            if not turn_id:
                raise HTTPException(status_code=400, detail="turnId is required")
            return await connection.request("turn/interrupt", {"threadId": session["thread_id"], "turnId": turn_id})
        upstream_request_id = values.get("approvalId") or values.get("requestId") or values.get("upstreamRequestId")
        if upstream_request_id:
            approval = self.store.approval(user, profile, session_id, str(upstream_request_id))
            if approval is None:
                raise HTTPException(status_code=404, detail="Approval request not found")
            if approval.get("method") not in _APPROVAL_METHODS:
                raise HTTPException(status_code=409, detail="This request must be resolved by the native Codex terminal")
            decision = values.get("decision")
            if decision not in _APPROVAL_DECISIONS:
                raise HTTPException(status_code=400, detail="decision is required")
            if approval.get("epoch") != connection.epoch:
                raise HTTPException(status_code=409, detail="Approval belongs to an expired Codex connection")
            try:
                approval_payload = json.loads(str(approval["payload"]))
                original_id = approval_payload.get("id", upstream_request_id)
            except (TypeError, json.JSONDecodeError):
                approval_payload = {}
                original_id = upstream_request_id
            available = approval_payload.get("params", {}).get("availableDecisions")
            if isinstance(available, list) and available:
                offered = {
                    item
                    for item in available
                    if isinstance(item, str)
                }
                if decision not in offered:
                    raise HTTPException(status_code=409, detail="This approval decision is not offered by Codex")
            if not self.store.claim_approval(user, profile, session_id, str(upstream_request_id), connection.epoch):
                raise HTTPException(status_code=409, detail="Approval request is already being resolved")
            try:
                await connection.respond(original_id, {"decision": decision})
            except Exception:
                self.store.mark_approval_unknown(user, profile, session_id, str(upstream_request_id))
                return {"status": "unknown", "requestId": str(upstream_request_id)}
            self.store.remove_approval(user, profile, session_id, str(upstream_request_id))
            return {"status": "accepted", "requestId": str(upstream_request_id)}
        raise HTTPException(status_code=400, detail="requestId and decision are required")


class SessionBody(BaseModel):
    """Input used to create a Workbench session or submit a message."""

    profile: str = "default"
    session_id: str | None = None
    clientRequestId: str | None = None
    client_request_id: str | None = None
    text: str | None = None
    input: list[dict[str, Any]] | None = None
    attachmentIds: list[str] | None = None
    model: str | None = None
    effort: str | None = None
    serviceTier: str | None = None
    turnId: str | None = None
    expectedTurnId: str | None = None
    readSeq: int | None = None
    approvalId: str | None = None
    requestId: str | None = None
    upstreamRequestId: str | None = None
    decision: str | None = None
    kind: str | None = None
    cwd: str | None = None
    workspace_id: str | None = None
    workspaceId: str | None = None
    title: str | None = None
    approvalPolicy: Any = None


class GroupCreateBody(BaseModel):
    """Input for creating a logical session group in the user and profile scope."""

    profile: str = "default"
    name: str


class GroupRenameBody(BaseModel):
    """Input for changing a session group's display name."""

    name: str


class OrganizationBody(BaseModel):
    """Optional session organization fields updated in one transaction."""

    favorite: bool | None = None
    groupId: str | None = None
    deleted: bool | None = None


class GoalBody(BaseModel):
    """Native Codex goal fields accepted by the Workbench goal editor."""

    objective: str | None = None
    status: str | None = None
    tokenBudget: int | None = None


def _user(request: Request | WebSocket) -> str:
    """Extract the trusted proxy identity and fail closed for malformed values."""

    headers = request.headers
    value = headers.get("remote-user") or headers.get("x-remote-user")
    if not value:
        raise HTTPException(status_code=401, detail="Missing trusted user identity")
    return _safe(value.strip().lower(), "user")


def create_router(bridge: CodexBridge | None = None) -> APIRouter:
    """Build the router mounted beneath ``/api/plugins/workbench/codex``."""

    service = bridge or CodexBridge()
    router = APIRouter()

    @router.get("/workspaces")
    async def workspaces(request: Request, profile: str = "default") -> dict[str, Any]:
        """List the workspace available to one profile."""

        return {"items": service.workspaces(profile, _user(request))}

    @router.get("/sessions")
    async def sessions(request: Request, profile: str = "default", limit: int = 50, offset: int = 0, deleted: bool = False) -> dict[str, Any]:
        """Return a page of identity-scoped session mappings."""

        return {"items": service.store.list_sessions(_user(request), _safe(profile, "profile"), min(max(limit, 1), _MAX_PAGE), max(offset, 0), deleted)}

    @router.get("/groups")
    async def groups(request: Request, profile: str = "default") -> dict[str, Any]:
        """List groups owned by the trusted user and selected profile."""

        return {"items": service.store.groups(_user(request), _safe(profile, "profile"))}

    @router.post("/groups")
    async def create_group(body: GroupCreateBody, request: Request) -> dict[str, Any]:
        """Create a logical group without changing any session execution directory."""

        user = _user(request)
        profile = _safe(body.profile, "profile")
        return {"group": await asyncio.to_thread(service.create_group, user, profile, body.name)}

    @router.patch("/groups/{group_id}")
    async def rename_group(group_id: str, body: GroupRenameBody, request: Request, profile: str = "default") -> dict[str, Any]:
        """Rename one group without crossing user or profile scope."""

        return {"group": await asyncio.to_thread(service.rename_group, _user(request), _safe(profile, "profile"), _safe(group_id, "group"), body.name)}

    @router.delete("/groups/{group_id}")
    async def delete_group(group_id: str, request: Request, profile: str = "default") -> dict[str, bool]:
        """Delete one group and leave its sessions ungrouped."""

        await asyncio.to_thread(service.store.delete_group, _user(request), _safe(profile, "profile"), _safe(group_id, "group"))
        return {"ok": True}

    @router.post("/sessions")
    async def create_session(body: SessionBody, request: Request) -> dict[str, Any]:
        """Create a Codex thread and its Workbench mapping."""

        return {"session": await service.create_session(_user(request), _safe(body.profile, "profile"), body.model_dump(exclude_none=True))}

    @router.get("/models")
    async def models(request: Request, profile: str = "default") -> dict[str, Any]:
        """Return model options advertised by Codex."""

        return await service.models(_user(request), _safe(profile, "profile"))

    @router.get("/session")
    async def session(request: Request, profile: str, session_id: str, after: int = 0, limit: int = 100, defer_persistence: bool = False) -> dict[str, Any]:
        """Return paginated history with a server-side event cursor."""

        return await service.history(_user(request), _safe(profile, "profile"), _safe(session_id, "session"), max(after, 0), min(max(limit, 1), _MAX_PAGE), defer_persistence=defer_persistence)

    @router.get("/session/preview")
    async def session_preview(request: Request, profile: str, session_id: str, turns: int = _PREVIEW_TURN_LIMIT) -> dict[str, Any]:
        """Return a recent local snapshot for fast first paint."""

        return await service.history_preview(_user(request), _safe(profile, "profile"), _safe(session_id, "session"), min(max(turns, 1), _PREVIEW_TURN_LIMIT))

    @router.get("/session/goal")
    async def get_goal(request: Request, profile: str, session_id: str) -> dict[str, Any]:
        """Read the native goal for one identity-scoped session."""

        return await service.get_goal(_user(request), _safe(profile, "profile"), _safe(session_id, "session"))

    @router.put("/session/goal")
    async def set_goal(body: GoalBody, request: Request, profile: str, session_id: str) -> dict[str, Any]:
        """Update the native goal without creating a synthetic chat message."""

        # Preserve an explicit ``null``: Codex uses ``tokenBudget: null`` to
        # clear a budget, while an omitted field keeps the current budget.
        values = body.model_dump(exclude_unset=True)
        return await service.set_goal(_user(request), _safe(profile, "profile"), _safe(session_id, "session"), values)

    @router.delete("/session/goal")
    async def clear_goal(request: Request, profile: str, session_id: str) -> dict[str, Any]:
        """Clear the native goal for one identity-scoped session."""

        return await service.clear_goal(_user(request), _safe(profile, "profile"), _safe(session_id, "session"))

    @router.patch("/session/organization")
    async def update_organization(body: OrganizationBody, request: Request, profile: str, session_id: str) -> dict[str, Any]:
        """Atomically update the supplied favorite, group, and deleted fields."""

        values = body.model_dump(exclude_unset=True)
        return {"session": await service.update_organization(_user(request), _safe(profile, "profile"), _safe(session_id, "session"), values)}

    @router.post("/session/steer")
    @router.post("/session")
    async def submit(body: SessionBody, request: Request, profile: str, session_id: str) -> dict[str, Any]:
        """Submit one idempotent client message to a Codex thread."""

        if request.url.path.endswith("/session/steer") and not body.expectedTurnId:
            raise HTTPException(status_code=422, detail="expectedTurnId is required for steering")
        values = body.model_dump(exclude_none=True)
        if body.clientRequestId is None and body.client_request_id is not None:
            values["clientRequestId"] = body.client_request_id
        return {"request": await service.submit(_user(request), _safe(profile, "profile"), _safe(session_id, "session"), values)}

    @router.post("/session/read")
    async def mark_read(body: SessionBody, request: Request, profile: str, session_id: str) -> dict[str, int]:
        """Advance per-user read progress without allowing it to move backwards."""

        seq = int(body.readSeq or 0)
        return {"readSeq": service.store.mark_read(_user(request), _safe(profile, "profile"), _safe(session_id, "session"), max(seq, 0))}

    @router.post("/session/stop")
    async def stop(body: SessionBody, request: Request, profile: str, session_id: str) -> dict[str, Any]:
        """Interrupt one running turn."""

        return await service.control(_user(request), _safe(profile, "profile"), _safe(session_id, "session"), "stop", body.model_dump(exclude_none=True))

    @router.post("/session/approval")
    async def approval(body: SessionBody, request: Request, profile: str, session_id: str) -> dict[str, Any]:
        """Resolve one pending Codex approval."""

        return await service.control(_user(request), _safe(profile, "profile"), _safe(session_id, "session"), "approval", body.model_dump(exclude_none=True))

    @router.websocket("/events")
    async def events(websocket: WebSocket, profile: str = "default", session_id: str = "", after: int = 0, defer_persistence: bool = False) -> None:
        """Send a history snapshot followed by live deduplicated events."""

        try:
            user = _user(websocket)
            profile_value = _safe(profile, "profile")
            session_value = _safe(session_id, "session")
            await websocket.accept()
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)
            key = (user, profile_value, session_value)
            service._subscribers.setdefault(key, set()).add(queue)
            try:
                # Register before reading history. Events racing the snapshot
                # are queued and clients deduplicate them by the stable seq.
                snapshot = await service.history(user, profile_value, session_value, max(after, 0), _MAX_PAGE, defer_persistence=defer_persistence)
                await websocket.send_json({"type": "snapshot", **snapshot})
                while True:
                    event_task = asyncio.create_task(queue.get())
                    heartbeat = asyncio.create_task(asyncio.sleep(1.0))
                    done, pending = await asyncio.wait({event_task, heartbeat}, return_when=asyncio.FIRST_COMPLETED)
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    if event_task in done:
                        await websocket.send_json({"type": "event", **event_task.result()})
                        continue
                    await websocket.send_json({"type": "heartbeat"})
                    connection = service._connections.get((user, profile_value))
                    if connection is not None and not connection.closed:
                        continue
                    try:
                        snapshot = await service.history(user, profile_value, session_value, snapshot.get("next", after), _MAX_PAGE, defer_persistence=defer_persistence)
                    except (HTTPException, RuntimeError):
                        continue
                    await websocket.send_json({"type": "snapshot", "reconnected": True, **snapshot})
            finally:
                service._subscribers.get(key, set()).discard(queue)
        except HTTPException:
            # A WebSocket failure must not escape through the HTTP response handler.
            await websocket.close(code=1013)
        except WebSocketDisconnect:
            return

    return router
