"""Stable, stdlib-only release store and recoverable sidecar supervisor transactions."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.request

ABI = 1
VERSION = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')
PENDING = {'preparing', 'queued', 'activating'}


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
        temporary = Path(stream.name)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class ReleaseStore:
    def __init__(self, root: Path):
        self.root = root
        self.releases = root / 'releases'
        self.current = root / 'current'
        self.job = root / 'update.json'

    def target(self, version: str) -> Path:
        if not VERSION.fullmatch(version):
            raise ValueError('Invalid managed release version')
        target = self.releases / version
        if target.is_symlink():
            raise ValueError('Release directory must not be a symlink')
        return target

    def active(self) -> str:
        target = self.current.resolve(strict=True)
        if target.parent != self.releases.resolve() or not VERSION.fullmatch(target.name):
            raise ValueError('Current release is outside the managed store')
        return target.name

    def status(self) -> dict:
        try:
            return json.loads(self.job.read_text())
        except FileNotFoundError:
            return {'phase': 'idle'}

    def validate(self, version: str, path: Path | None = None) -> Path:
        target = path or self.target(version)
        metadata = json.loads((target / 'release.json').read_text())
        if metadata.get('version') != version or metadata.get('runtime_abi') != ABI:
            raise ValueError('此版本不支持完整更新，或需要管理员升级运行环境。')
        hashes = json.loads((target / 'release-files.json').read_text())
        required = ['plugin/dashboard/manifest.json', 'sidecar/dashboard/manifest.json',
                    'sidecar/dashboard/sidecar_app.py', 'sidecar/dashboard/workbench_version_manager.py',
                    'sidecar/dashboard/release_runtime.py', 'plugin/dashboard/dist/index.js',
                    'plugin/dashboard/dist/style.css', 'plugin/dashboard/dist/workbench.js',
                    'plugin/dashboard/dist/workbench.css', 'plugin/dashboard/dist/mermaid.min.js',
                    'sidecar/dashboard/dist/index.js', 'sidecar/dashboard/dist/style.css']
        if not all(name in hashes for name in required):
            raise ValueError('Incomplete release inventory')
        for name, digest in hashes.items():
            relative = PurePosixPath(name)
            if relative.is_absolute() or '..' in relative.parts or name != relative.as_posix():
                raise ValueError('Unsafe inventory path')
            file = target / name
            if file.is_symlink() or not file.resolve().is_relative_to(target.resolve()):
                raise ValueError('Unsafe release file')
            if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
                raise ValueError('Release file checksum mismatch: ' + name)
        for name in ['plugin/dashboard/manifest.json', 'sidecar/dashboard/manifest.json']:
            if json.loads((target / name).read_text()).get('version') != version:
                raise ValueError('Frontend/backend release version mismatch')
        for built, installed in [('index.js', 'workbench.js'), ('style.css', 'workbench.css')]:
            if hashes['sidecar/dashboard/dist/' + built] != hashes['plugin/dashboard/dist/' + installed]:
                raise ValueError('Frontend/backend assets differ')
        return target

    def stage(self, data: bytes, version: str) -> Path:
        target = self.target(version)
        if target.exists():
            return self.validate(version)
        self.releases.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.download-', dir=self.releases) as directory:
            stage = Path(directory)
            prefix = f'hermes-workbench-v{version}/'
            size = 0
            seen = set()
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
                for member in archive:
                    if member.isdir():
                        continue
                    if not member.name.startswith(prefix):
                        raise ValueError('Unexpected release root')
                    name = member.name[len(prefix):]
                    rel = PurePosixPath(name)
                    if (not name or rel.is_absolute() or '..' in rel.parts or name != rel.as_posix() or name in seen
                            or not member.isfile() or member.size > 40 * 1024 * 1024):
                        raise ValueError('Unsafe release member')
                    seen.add(name)
                    size += member.size
                    if size > 200 * 1024 * 1024 or len(seen) > 10000:
                        raise ValueError('Expanded release exceeds limits')
                    dest = stage / name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, dest.open('wb') as output:
                        output.write(source.read())
                    dest.chmod(0o644)
            self.validate(version, stage)
            # Published versions are immutable; updates only replace the current symlink.
            for item in stage.rglob('*'):
                item.chmod(0o555 if item.is_dir() else 0o444)
            stage.chmod(0o555)
            os.rename(stage, target)
        return target

    def activate(self, version: str) -> None:
        target = self.target(version)
        if not target.is_dir():
            raise ValueError('Release missing')
        temporary = self.root / '.current-next'
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(Path('releases') / version, target_is_directory=True)
        os.replace(temporary, self.current)

    def recover(self) -> None:
        job = self.status()
        if job.get('phase') in PENDING:
            self.validate(job['previous'])
            self.activate(job['previous'])
            write_json(self.job, {**job, 'phase': 'failed', 'error': '更新被中断，已恢复原版本。'})


def stop_sidecar(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


class ReleaseController:
    """Loaded from the stable bootstrap, never from the replaceable current release."""
    def __init__(self, store: ReleaseStore, command: list[str], health_url: str):
        self.store, self.command, self.health_url = store, command, health_url

    def wait_healthy(self, process: subprocess.Popen, version: str, timeout: float = 60) -> None:
        deadline = time.monotonic() + timeout
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('新后端启动退出')
            try:
                with opener.open(self.health_url, timeout=2) as response:
                    if json.load(response).get('version') == version:
                        return
            except (OSError, ValueError):
                pass
            time.sleep(0.25)
        raise RuntimeError('后端健康检查超时')

    def apply_pending(self, processes: list[subprocess.Popen]) -> None:
        job = self.store.status()
        if job.get('phase') != 'queued':
            return
        # Let the API's enqueue response reach the browser before replacing its process.
        if time.time() - job['created_at'] < 2:
            return
        try:
            self.store.validate(job['version'])
            if self.store.active() != job['previous']:
                raise ValueError('Current release changed while update was queued')
        except Exception as exc:
            write_json(self.store.job, {**job, 'phase': 'failed', 'error': str(exc)})
            return
        write_json(self.store.job, {**job, 'phase': 'activating'})
        try:
            stop_sidecar(processes[0])
            self.store.activate(job['version'])
            processes[0] = subprocess.Popen(self.command)
            self.wait_healthy(processes[0], job['version'])
        except Exception as exc:
            stop_sidecar(processes[0])
            self.store.activate(job['previous'])
            processes[0] = subprocess.Popen(self.command)
            self.wait_healthy(processes[0], job['previous'])
            write_json(self.store.job, {**job, 'phase': 'failed', 'error': '已回滚原版本：' + str(exc)})
            return
        write_json(self.store.job, {**job, 'phase': 'succeeded'})
