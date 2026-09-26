"""Read-only Hermes cross-session search for the Codex app-server.

The normal Hermes ``session_search`` tool is owned by the Hermes agent loop.
Codex app-server owns its loop, so this small stdio MCP server exposes the same
SQLite/FTS5 implementation without importing or starting an AIAgent.
"""

from __future__ import annotations

import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations


def _root() -> Path:
    value = os.environ.get("HERMES_WORKBENCH_HERMES_HOME", "").strip()
    if not value:
        raise ValueError("HERMES_WORKBENCH_HERMES_HOME must be explicitly configured")
    return Path(value).expanduser().resolve()


def _profile_db(profile: str | None) -> Path:
    root = _root()
    name = (profile or "default").strip() or "default"
    if name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("invalid profile name")
    path = root / "state.db" if name == "default" else root / "profiles" / name / "state.db"
    path = path.resolve()
    path.relative_to(root)
    if not path.is_file():
        raise FileNotFoundError(f"Hermes profile database not found: {path}")
    return path


def _search(
    query: str = "",
    role_filter: str | None = None,
    limit: int = 3,
    session_id: str | None = None,
    around_message_id: int | None = None,
    window: int = 5,
    sort: str | None = None,
    profile: str | None = None,
) -> str:
    # Import from the pinned Hermes source only after MCP startup. This keeps
    # the server cheap and ensures its schema/FTS behavior stays in sync.
    import sys

    source = os.environ.get("HERMES_SOURCE", "").strip()
    if source and source not in sys.path:
        sys.path.insert(0, source)
    from hermes_state import SessionDB
    from tools.session_search_tool import session_search

    if session_id:
        session_id = session_id.removeprefix("@session:")
        if "/" in session_id:
            embedded_profile, session_id = session_id.split("/", 1)
            if profile and profile != embedded_profile:
                raise ValueError("conflicting session profile")
            profile = embedded_profile
    db = SessionDB(db_path=_profile_db(profile), read_only=True)
    try:
        if session_id and not db.get_session(session_id):
            raise ValueError("session not found in the selected profile")
        return session_search(
            query=query or "",
            role_filter=role_filter,
            limit=max(1, min(int(limit), 20)),
            session_id=session_id,
            around_message_id=around_message_id,
            window=max(1, min(int(window), 50)),
            sort=sort,
            db=db,
        )
    finally:
        db.close()


mcp = FastMCP(
    "hermes-session-search",
    instructions=(
        "Hermes cross-session recall. Before answering a request that may rely "
        "on earlier work, search this tool for relevant history. It reads the "
        "Hermes SQLite FTS5 index and returns actual prior messages; it makes no "
        "LLM calls and is read-only. Use profile= only when searching a named "
        "Hermes profile."
    ),
)


@mcp.tool(name="session_search", annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
def session_search_mcp(
    query: str = "",
    role_filter: str | None = None,
    limit: int = 3,
    session_id: str | None = None,
    around_message_id: int | None = None,
    window: int = 5,
    sort: str | None = None,
    profile: str | None = None,
) -> str:
    """Search or scroll Hermes conversations across sessions.

    Pass query for FTS5 discovery, session_id+around_message_id to scroll,
    session_id alone to read a linked session, or no arguments to browse recent
    sessions. Search results include snippets and real surrounding messages.
    """

    return _search(query, role_filter, limit, session_id, around_message_id, window, sort, profile)


if __name__ == "__main__":
    mcp.run(transport="stdio")
