#!/usr/bin/env python3
"""Run the Workbench web service and Codex app server in one container."""

from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import subprocess
import time
from pathlib import Path


def initialize_identity() -> None:
    """Create the bind-mount owner's passwd entry through the existing initializer."""

    environment = os.environ.copy()
    environment["HERMES_WORKBENCH_IDENTITY_ONLY"] = "1"
    subprocess.run(
        ["/bin/sh", str(Path(__file__).with_name("sidecar_entrypoint.sh"))],
        env=environment,
        check=True,
    )


def seed_codex_credentials() -> None:
    """Create private app-server authentication files once and preserve later refreshes."""

    uid = int(os.environ["HERMES_WORKBENCH_RUNTIME_UID"])
    gid = int(os.environ["HERMES_WORKBENCH_RUNTIME_GID"])
    token_path = Path(os.environ["CODEX_APP_SERVER_TOKEN_FILE"])
    token_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(token_path.parent, uid, gid)
    if not token_path.exists():
        token_path.write_text(secrets.token_urlsafe(48), encoding="utf-8")
        token_path.chmod(0o600)
        os.chown(token_path, uid, gid)

    auth_path = Path(os.environ["CODEX_HOME"]) / "auth.json"
    if not auth_path.exists():
        source = os.environ.get("HERMES_WORKBENCH_CODEX_AUTH_SOURCE")
        if not source:
            raise RuntimeError("Sign in with Codex in CODEX_HOME, or set HERMES_WORKBENCH_CODEX_AUTH_SOURCE explicitly")
        pool = json.loads(Path(source).read_text(encoding="utf-8"))
        credential = pool["providers"]["openai-codex"]
        if not credential.get("tokens"):
            raise RuntimeError("Configured Codex credentials are unavailable")
        auth_path.write_text(json.dumps(credential), encoding="utf-8")
        auth_path.chmod(0o600)
        os.chown(auth_path, uid, gid)


def drop_privileges() -> None:
    """Run both long-lived services as the configured bind-mount owner."""

    uid = int(os.environ["HERMES_WORKBENCH_RUNTIME_UID"])
    gid = int(os.environ["HERMES_WORKBENCH_RUNTIME_GID"])
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


def _codex_command() -> list[str]:
    """Build the shared Codex app-server command from the active container settings."""

    managed_binary = Path("/opt/data/bin/codex-runtime/codex")
    command = [str(managed_binary)] if managed_binary.is_file() else ["/usr/local/bin/codex", "app-server"]
    return [
        *command,
        "--listen",
        "ws://127.0.0.1:4500",
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        os.environ["CODEX_APP_SERVER_TOKEN_FILE"],
    ]


def _restart_codex(processes: list[subprocess.Popen[bytes]], command: list[str]) -> dict[str, object]:
    """Restart only Codex, keeping the Workbench API available throughout the update."""

    old = processes[1]
    if old.poll() is None:
        old.terminate()
        try:
            old.wait(timeout=20)
        except subprocess.TimeoutExpired:
            old.kill()
            old.wait(timeout=5)
    replacement = subprocess.Popen(command)
    processes[1] = replacement
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        code = replacement.poll()
        if code is not None:
            raise RuntimeError(f"Codex app-server exited during restart (code {code})")
        try:
            with socket.create_connection(("127.0.0.1", 4500), timeout=0.5):
                return {"ok": True, "pid": replacement.pid}
        except OSError:
            time.sleep(0.25)
    replacement.terminate()
    raise TimeoutError("Codex app-server did not become ready within 45 seconds")


def _serve_restart_control(listener: socket.socket, processes: list[subprocess.Popen[bytes]], command: list[str]) -> None:
    """Handle Codex-only restart requests on a private filesystem-protected socket."""

    try:
        connection, _ = listener.accept()
    except TimeoutError:
        return
    with connection:
        try:
            request = connection.recv(256).decode("utf-8").strip()
            if request != "restart_codex":
                raise ValueError("unsupported supervisor command")
            response = _restart_codex(processes, command)
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}
        connection.sendall((json.dumps(response) + "\n").encode("utf-8"))


def stop_processes(processes: list[subprocess.Popen[bytes]]) -> None:
    """Stop both services together so Docker can restart a coherent pair."""

    for process in processes:
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and any(process.poll() is None for process in processes):
        time.sleep(0.1)
    for process in processes:
        if process.poll() is None:
            process.kill()


def run_services() -> int:
    """Supervise both services and accept private Codex-only restart requests."""

    controller = None
    sidecar = Path('/opt/workbench/dashboard/sidecar_app.py')
    if os.environ.get('WORKBENCH_RELEASE_HOME'):
        from release_runtime import ReleaseStore, ReleaseController
        store = ReleaseStore(Path(os.environ['WORKBENCH_RELEASE_HOME']))
        store.recover()
        store.validate(store.active())
        sidecar = store.current / 'sidecar/dashboard/sidecar_app.py'
        controller = ReleaseController(store, ['/opt/hermes/.venv/bin/python', str(sidecar)],
                                       'http://127.0.0.1:' + os.environ.get('HERMES_WORKBENCH_PORT', '8787') + '/health')
    codex_command = _codex_command()
    commands = [
        ["/opt/hermes/.venv/bin/python", str(sidecar)],
        codex_command,
    ]
    processes = [subprocess.Popen(command) for command in commands]
    control_path = Path(os.environ["CODEX_HOME"]) / "app-server-supervisor.sock"
    control_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    control_path.unlink(missing_ok=True)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(control_path))
    control_path.chmod(0o600)
    listener.listen(2)
    listener.settimeout(0.25)
    stopping = False

    def request_stop(_signum: int, _frame: object) -> None:
        """Record the container stop request for the supervisor loop."""

        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        while not stopping:
            if controller:
                controller.apply_pending(processes)
            _serve_restart_control(listener, processes, codex_command)
            for index, process in enumerate(processes):
                code = process.poll()
                if code is None:
                    continue
                if index == 1:
                    time.sleep(1)
                    try:
                        processes[index] = subprocess.Popen(codex_command)
                    except OSError:
                        return code if code else 1
                    continue
                return code if code else 1
            time.sleep(0.25)
        return 0
    finally:
        listener.close()
        control_path.unlink(missing_ok=True)
        stop_processes(processes)


def main() -> int:
    """Initialize the shared state, drop root, and start the combined runtime."""

    if os.getuid() == 0:
        initialize_identity()
        seed_codex_credentials()
        drop_privileges()
    return run_services()


if __name__ == "__main__":
    raise SystemExit(main())
