# Session recall integration

The optional read-only MCP adapter is `dashboard/hermes_session_search_mcp.py`.
Configure it in the Codex home used by your instance. Use absolute paths from
that instance; do not copy another user's configuration or session identifiers.

```toml
[mcp_servers.hermes-session-search]
command = "/path/to/python"
args = ["/path/to/hermes-workbench/dashboard/hermes_session_search_mcp.py"]

[mcp_servers.hermes-session-search.env]
HERMES_WORKBENCH_HERMES_HOME = "/path/to/hermes-data"
HERMES_SOURCE = "/path/to/hermes-source"
```

The Python environment must include the project's Python requirements and a
compatible Hermes installation. Environment variables must be included in the
MCP configuration explicitly. The adapter uses `SessionDB(read_only=True)` and
profile-specific paths; it does not edit Hermes core or session data.

To verify, start a new session, check that `session_search` is available with
`readOnlyHint=true`, and query a history item belonging to your test profile.
Verify that it cannot access another profile. Search uses FTS5 keywords, not
semantic vectors; model-selected recall is not unconditional retrieval.

To remove the integration, remove this MCP server entry and any recall guidance
you added to your workspace instructions. Open a new session to load changes;
do not restart the service from an active task.
