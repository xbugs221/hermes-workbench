"""Check, install, and supervise stable Codex app-server package updates."""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import APIRouter, HTTPException

from codex_runtime_control import restart_codex_app_server

logger = logging.getLogger(__name__)
CODEX_ROOT = Path("/opt/data/bin/codex-runtime")
CODEX_BINARY = CODEX_ROOT / "codex"
CODE_MODE_HOST = CODEX_ROOT / "codex-code-mode-host"
CODEX_HOME = Path(os.environ.get("CODEX_HOME", "/opt/data/.hermes-workbench/codex-home"))
STATE_FILE = CODEX_HOME / "version.json"
RELEASE_API = "https://api.github.com/repos/openai/codex/releases/latest"
ASSET_NAME = "codex-app-server-package-x86_64-unknown-linux-musl.tar.gz"
MAX_PACKAGE_SIZE = 256 * 1024 * 1024
CHECK_INTERVAL = 24 * 60 * 60


def _now() -> str:
    """Return a UTC timestamp for persistent update status."""

    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _version_tuple(value: str) -> tuple[int, ...]:
    """Normalize Codex release tags for numeric version comparisons."""

    match = re.search(r"(\d+(?:\.\d+)+)", value)
    if not match:
        raise ValueError(f"Unrecognized Codex version: {value}")
    return tuple(int(part) for part in match.group(1).split("."))


def _read_state() -> dict[str, Any]:
    """Load update metadata without exposing authentication data from CODEX_HOME."""

    try:
        payload = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_state(state: dict[str, Any]) -> None:
    """Persist updater metadata by atomically replacing the state file."""

    STATE_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = STATE_FILE.with_name(f".{STATE_FILE.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, STATE_FILE)


def _installed_version(binary: Path = CODEX_BINARY) -> str:
    """Read the exact version from a Codex executable."""

    result = subprocess.run([str(binary), "--version"], check=True, capture_output=True, text=True, timeout=15)
    match = re.search(r"(\d+(?:\.\d+)+)", result.stdout)
    if not match:
        raise RuntimeError(f"Could not parse Codex version: {result.stdout.strip()}")
    return match.group(1)


def _running_codex() -> tuple[str, str]:
    """Identify the executable and version serving Workbench's Codex socket."""

    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            arguments = (process / "cmdline").read_bytes().split(b"\0")
            if b"--listen" not in arguments or b"ws://127.0.0.1:4500" not in arguments:
                continue
            executable = process / "exe"
            return os.readlink(executable), _installed_version(executable)
        except (OSError, subprocess.SubprocessError):
            continue
    return "", "unknown"


def _verify_running_codex(expected_version: str) -> None:
    """Require the active app-server to match the managed package."""

    binary, version = _running_codex()
    if binary != str(CODEX_BINARY) or version != expected_version:
        raise RuntimeError(
            f"Codex app-server mismatch: running {binary or 'none'} {version}; "
            f"expected {CODEX_BINARY} {expected_version}"
        )


class CodexUpdateManager:
    """Own release checks and atomic replacement of the app-server package."""

    def __init__(self) -> None:
        """Create a process lock; a file lock coordinates concurrent worker processes."""

        self._lock = threading.Lock()
        self._latest: dict[str, Any] | None = None

    def _latest_release(self) -> dict[str, Any]:
        """Fetch the latest stable release and require its official package digest."""

        request = urllib.request.Request(
            RELEASE_API,
            headers={"Accept": "application/vnd.github+json", "User-Agent": "hermes-workbench-codex-updater"},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            release = json.load(response)
        if release.get("draft") or release.get("prerelease"):
            raise RuntimeError("GitHub latest release endpoint returned a non-stable release")
        tag = str(release.get("tag_name") or "")
        version = _version_tuple(tag)
        asset = next((row for row in release.get("assets", []) if row.get("name") == ASSET_NAME), None)
        if not asset:
            raise RuntimeError(f"Codex release {tag} does not contain {ASSET_NAME}")
        digest = str(asset.get("digest") or "")
        if not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
            raise RuntimeError("GitHub did not provide a SHA-256 digest for the Codex app-server package")
        return {
            "version": ".".join(map(str, version)),
            "url": str(asset.get("browser_download_url") or ""),
            "digest": digest.split(":", 1)[1].lower(),
        }

    def is_busy(self) -> bool:
        """Fail closed when Workbench has an active or uncertain Codex turn."""

        database = Path(os.environ.get("HERMES_WORKBENCH_CODEX_DB") or os.environ.get(
            "HERMES_WORKBENCH_RUNTIME_DB", "/opt/data/.hermes-workbench/codex.sqlite3"
        ))
        if not database.is_file():
            return True
        try:
            connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2)
            try:
                active_sessions = connection.execute(
                    "SELECT COUNT(*) FROM codex_sessions WHERE status='running'"
                ).fetchone()[0]
            finally:
                connection.close()
            return bool(active_sessions)
        except sqlite3.Error:
            return True

    def status(self, *, refresh: bool = False) -> dict[str, Any]:
        """Report active, installed, and latest Codex versions."""

        state = _read_state()
        checked = state.get("last_checked_at")
        is_fresh = False
        if not refresh and checked:
            try:
                checked_at = datetime.fromisoformat(str(checked).replace("Z", "+00:00"))
                is_fresh = time.time() - checked_at.timestamp() < 3600
            except ValueError:
                pass
        if self._latest is None and state.get("latest_version"):
            self._latest = {"version": str(state["latest_version"]), "url": "", "digest": ""}
        if refresh or not is_fresh or self._latest is None:
            self._latest = self._latest_release()
            state["latest_version"] = self._latest["version"]
            state["last_checked_at"] = _now()
            state.pop("last_error", None)
            _write_state(state)
        installed = _installed_version()
        running_binary, running_version = _running_codex()
        runtime_mismatch = running_binary != str(CODEX_BINARY) or running_version != installed
        latest = str((self._latest or {}).get("version") or "unknown")
        available = runtime_mismatch or (latest != "unknown" and _version_tuple(latest) > _version_tuple(installed))
        return {
            "installed_version": running_version,
            "package_version": installed,
            "running_binary": running_binary,
            "runtime_mismatch": runtime_mismatch,
            "latest_version": latest,
            "update_available": available,
            "last_checked_at": state.get("last_checked_at"),
            "last_updated_at": state.get("last_updated_at"),
            "busy": self.is_busy(),
            "error": state.get("last_error"),
        }

    def update_latest(self) -> dict[str, Any]:
        """Verify, install, and restart Codex; restore both binaries if restart fails."""

        with self._lock:
            CODEX_ROOT.mkdir(parents=True, exist_ok=True)
            with (CODEX_ROOT / ".update.lock").open("a+") as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                state = _read_state()
                old_version = _installed_version()
                try:
                    release = self._latest_release()
                    self._latest = release
                    state.update(latest_version=release["version"], last_checked_at=_now(), last_error=None)
                    _write_state(state)
                    if _version_tuple(release["version"]) <= _version_tuple(old_version):
                        if _running_codex() != (str(CODEX_BINARY), old_version):
                            restart_codex_app_server()
                            _verify_running_codex(old_version)
                        return self.status()
                    if not release["url"]:
                        raise RuntimeError("Codex package download URL is missing")
                    with tempfile.TemporaryDirectory(prefix="codex-update-", dir=CODEX_ROOT) as temporary_dir:
                        temporary = Path(temporary_dir)
                        archive = temporary / "codex-app-server.tar.gz"
                        request = urllib.request.Request(release["url"], headers={"User-Agent": "hermes-workbench-codex-updater"})
                        digest = hashlib.sha256()
                        size = 0
                        with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as output:
                            while chunk := response.read(1024 * 1024):
                                size += len(chunk)
                                if size > MAX_PACKAGE_SIZE:
                                    raise RuntimeError("Codex package exceeds the 256 MiB safety limit")
                                digest.update(chunk)
                                output.write(chunk)
                        if digest.hexdigest() != release["digest"]:
                            raise RuntimeError("Codex package SHA-256 does not match the official release digest")
                        staged: dict[str, Path] = {}
                        required = {"codex": temporary / "codex", "codex-code-mode-host": temporary / "codex-code-mode-host"}
                        package_names = {"codex-app-server": "codex", "codex-code-mode-host": "codex-code-mode-host"}
                        with tarfile.open(archive, "r:gz") as package:
                            for member in package.getmembers():
                                name = package_names.get(PurePosixPath(member.name).name)
                                if name not in required or name in staged or not member.isfile() or member.size > MAX_PACKAGE_SIZE:
                                    continue
                                source = package.extractfile(member)
                                if source is None:
                                    continue
                                target = required[name]
                                with source, target.open("wb") as output:
                                    shutil.copyfileobj(source, output)
                                target.chmod(0o775)
                                staged[name] = target
                        if set(staged) != set(required):
                            raise RuntimeError("Codex app-server package is missing its CLI or code-mode host")
                        new_version = _installed_version(staged["codex"])
                        if new_version != release["version"]:
                            raise RuntimeError(f"Downloaded Codex version {new_version} does not match release {release['version']}")
                        backups = {"codex": temporary / "codex.old", "codex-code-mode-host": temporary / "codex-code-mode-host.old"}
                        targets = {"codex": CODEX_BINARY, "codex-code-mode-host": CODE_MODE_HOST}
                        for name, target in targets.items():
                            shutil.copy2(target, backups[name])
                        try:
                            for name, target in targets.items():
                                os.chmod(staged[name], target.stat().st_mode & 0o777)
                                os.replace(staged[name], target)
                            restart_codex_app_server()
                            _verify_running_codex(new_version)
                        except Exception:
                            for name, target in targets.items():
                                os.replace(backups[name], target)
                            try:
                                restart_codex_app_server()
                            except Exception:
                                logger.exception("Codex rollback restored files but app-server restart also failed")
                            raise
                    state.update(last_updated_at=_now(), last_error=None)
                    _write_state(state)
                    logger.info("Codex app-server updated from %s to %s and restarted", old_version, release["version"])
                    return self.status()
                except Exception as exc:
                    state["last_error"] = str(exc)
                    state["last_checked_at"] = _now()
                    _write_state(state)
                    raise


def create_router(manager: CodexUpdateManager) -> APIRouter:
    """Expose version status and an authenticated manual update action."""

    router = APIRouter()

    @router.get("/status")
    async def status() -> dict[str, Any]:
        """Show installed/latest versions and whether an update is available."""

        try:
            return await asyncio.to_thread(manager.status)
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Codex version check failed: {exc}") from exc

    @router.post("/update")
    async def update() -> dict[str, Any]:
        """Install the latest stable package and restart the app-server."""

        try:
            return await asyncio.to_thread(manager.update_latest)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Codex update failed: {exc}") from exc

    return router


async def run_auto_updates(manager: CodexUpdateManager) -> None:
    """Check and apply stable Codex releases daily while Workbench is running."""

    await asyncio.sleep(60)
    while os.environ.get("CODEX_AUTO_UPDATE_ENABLED", "1").strip().lower() not in {"0", "false", "off"}:
        try:
            current = await asyncio.to_thread(manager.status, refresh=True)
            if current["update_available"]:
                busy = await asyncio.to_thread(manager.is_busy)
                if busy:
                    logger.info("Automatic Codex update deferred while a Codex turn is active or uncertain")
                else:
                    await asyncio.to_thread(manager.update_latest)
        except Exception:
            logger.exception("Automatic Codex app-server update failed")
        await asyncio.sleep(CHECK_INTERVAL)
