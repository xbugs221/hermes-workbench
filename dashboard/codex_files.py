"""Expose session-scoped Codex workspace files through the Workbench API.

The legacy dashboard file handlers remain the single implementation of path
validation, sensitive-file filtering, text limits, and optimistic writes. This
router only authenticates and resolves the Codex session, then scopes those
handlers with a request-local workspace root.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import plugin_api
from codex_attachments import create_router as create_attachment_router
from codex_bridge import CodexBridge, _safe, _user
from fastapi import APIRouter, HTTPException, Query, Request


@contextmanager
def _workspace_scope(root: Path) -> Iterator[None]:
    """Install one workspace root for the current request context."""

    token = plugin_api._WORKSPACE_ROOT_OVERRIDE.set(root)
    try:
        yield
    finally:
        plugin_api._WORKSPACE_ROOT_OVERRIDE.reset(token)


async def _session_workspace(
    bridge: CodexBridge, request: Request, profile: str, session_id: str
) -> Path:
    """Resolve a workspace only from the trusted user and exact session mapping."""

    user = _user(request)
    checked_profile = _safe(profile, "profile")
    checked_session = _safe(session_id, "session")
    session = await asyncio.to_thread(
        bridge.store.session, user, checked_profile, checked_session
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Codex session not found")
    raw_path = session.get("workspace_path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise HTTPException(status_code=404, detail="Codex session workspace is unavailable")
    try:
        root = Path(raw_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=404, detail="Codex session workspace is unavailable")
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="Codex session workspace is unavailable")
    return root


def create_router(bridge: CodexBridge) -> APIRouter:
    """Build file and attachment routes bound to one bridge's sessions."""

    router = APIRouter()

    @router.get("/files")
    async def list_session_files(
        request: Request,
        profile: str = "default",
        session_id: str = "",
        path: str = Query(default=""),
    ) -> dict[str, Any]:
        """List files beneath the authenticated Codex session workspace."""

        root = await _session_workspace(bridge, request, profile, session_id)
        with _workspace_scope(root):
            return await plugin_api.list_files(path)

    @router.get("/file")
    async def get_session_file(
        request: Request,
        profile: str = "default",
        session_id: str = "",
        path: str = Query(...),
    ) -> dict[str, Any]:
        """Read one UTF-8 file from the authenticated Codex session workspace."""

        root = await _session_workspace(bridge, request, profile, session_id)
        with _workspace_scope(root):
            return await plugin_api.get_file(path)

    @router.get("/asset")
    async def get_session_asset(
        request: Request,
        profile: str = "default",
        session_id: str = "",
        path: str = Query(...),
    ):
        """Serve one approved image from the authenticated Codex session workspace."""

        root = await _session_workspace(bridge, request, profile, session_id)
        with _workspace_scope(root):
            return await plugin_api.get_asset(path)

    @router.put("/file")
    async def put_session_file(
        request: Request,
        body: plugin_api.FileWriteBody,
        profile: str = "default",
        session_id: str = "",
        path: str = Query(...),
    ) -> dict[str, Any]:
        """Write one UTF-8 file in the authenticated Codex session workspace."""

        root = await _session_workspace(bridge, request, profile, session_id)
        with _workspace_scope(root):
            return await plugin_api.put_file(body, path)

    router.include_router(create_attachment_router(bridge))
    return router


__all__ = ["create_router"]
