"""Private control client for restarting the supervised Codex app-server process."""

from __future__ import annotations

import json
import os
import socket
from pathlib import Path


def restart_codex_app_server(timeout: float = 55.0) -> dict[str, object]:
    """Ask the supervisor to replace Codex and wait for its WebSocket port."""

    codex_home = Path(os.environ.get("CODEX_HOME", "/opt/data/.hermes-workbench/codex-home"))
    control_path = codex_home / "app-server-supervisor.sock"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as control:
        control.settimeout(timeout)
        control.connect(str(control_path))
        control.sendall(b"restart_codex\n")
        chunks: list[bytes] = []
        while sum(map(len, chunks)) < 8192:
            chunk = control.recv(1024)
            if not chunk or b"\n" in chunk:
                chunks.append(chunk)
                break
            chunks.append(chunk)
    if not chunks:
        raise RuntimeError("Codex supervisor returned no restart result")
    try:
        response = json.loads(b"".join(chunks).split(b"\n", 1)[0])
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Codex supervisor returned an invalid restart result") from exc
    if not response.get("ok"):
        raise RuntimeError(str(response.get("error") or "Codex app-server restart failed"))
    return response
