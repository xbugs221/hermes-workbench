"""User-selected GitHub browser releases, verified downloads and local rollback."""
from __future__ import annotations

import asyncio
import fcntl
import uuid
import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from release_runtime import ReleaseStore, PENDING, write_json

PLUGIN_ROOT = Path(os.environ.get('HERMES_WORKBENCH_PLUGIN_ROOT', '/opt/data/plugins/workbench'))
DIST = PLUGIN_ROOT / 'dashboard/dist'
MANIFEST = PLUGIN_ROOT / 'dashboard/manifest.json'
RELEASES = PLUGIN_ROOT / 'dashboard/releases'
REPOSITORY = os.environ.get('HERMES_WORKBENCH_RELEASE_REPOSITORY', 'xbugs221/hermes-workbench')
if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', REPOSITORY):
    raise ValueError('HERMES_WORKBENCH_RELEASE_REPOSITORY must be owner/repository')
VERSION_RE = re.compile(r'^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$')
SEMVER_RE = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$')
ASSETS = ('workbench.js', 'workbench.css', 'mermaid.min.js')
_lock = threading.Lock()
_catalog_lock = threading.Lock()
_admission_lock = threading.Lock()
_active_mutations = 0
_catalog: tuple[float, list[dict]] = (0, [])


def managed_store() -> ReleaseStore | None:
    root = os.environ.get('WORKBENCH_RELEASE_HOME')
    return ReleaseStore(Path(root)) if root else None


def update_pending() -> bool:
    store = managed_store()
    return bool(store and store.status().get('phase') in PENDING)


def begin_mutation() -> bool:
    global _active_mutations
    with _admission_lock:
        if update_pending():
            return False
        _active_mutations += 1
        return True


def end_mutation() -> None:
    global _active_mutations
    with _admission_lock:
        _active_mutations -= 1


async def _codex_busy() -> bool:
    from codex_update_manager import CodexUpdateManager
    from codex_bridge import WebSocketJsonTransport
    if CodexUpdateManager().is_busy():
        return True
    connection = await WebSocketJsonTransport.connect(os.environ['CODEX_APP_SERVER_ENDPOINT'])
    serial = 0
    async def rpc(method, params):
        nonlocal serial
        serial += 1
        await connection.send({'id': serial, 'method': method, 'params': params})
        while True:
            result = await asyncio.wait_for(connection.receive(), 15)
            if result.get('id') == serial:
                if 'error' in result:
                    raise RuntimeError('Unable to check active tasks')
                return result['result']
    try:
        await rpc('initialize', {'clientInfo': {'name': 'workbench-release-update', 'version': '1'},
                                 'capabilities': {'experimentalApi': True}})
        await connection.send({'method': 'initialized', 'params': {}})
        rows = await rpc('thread/loaded/list', {})
        if rows.get('nextCursor'):
            return True
        for tid in rows.get('data', []):
            thread = (await rpc('thread/read', {'threadId': tid, 'includeTurns': False}))['thread']
            if thread.get('status', {}).get('type') not in ['idle', 'notLoaded']:
                return True
        return False
    finally:
        await connection.close()


def _switch_managed(version: str, store: ReleaseStore) -> dict:
    store.target(version)
    store.root.mkdir(parents=True, exist_ok=True)
    with (store.root / 'update.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HTTPException(409, '另一个版本正在准备，请稍后重试。')
        if store.status().get('phase') in PENDING:
            raise HTTPException(409, '另一个版本正在切换，请稍后重试。')
        previous = store.active()
        if version == previous:
            return {'active': previous, 'ok': True}
        job = {'id': uuid.uuid4().hex, 'phase': 'preparing', 'version': version,
               'previous': previous, 'created_at': time.time()}
        with _admission_lock:
            if _active_mutations:
                raise HTTPException(409, '正在处理其他操作，请稍后更新。')
            write_json(store.job, job)
        try:
            if asyncio.run(_codex_busy()):
                raise HTTPException(409, '有任务正在运行，请等任务结束后更新。')
            if not store.target(version).exists():
                _download_release(version)
            store.validate(version)
            if asyncio.run(_codex_busy()):
                raise HTTPException(409, '有任务正在运行，版本已下载，请等任务结束后切换。')
            write_json(store.job, {**job, 'phase': 'queued', 'created_at': time.time()})
        except Exception as exc:
            write_json(store.job, {**job, 'phase': 'failed', 'error': str(getattr(exc, 'detail', exc))})
            raise
        return {'active': previous, 'ok': True, 'pending': True, 'job_id': job['id']}


class VersionSwitch(BaseModel):
    version: str = Field(min_length=1, max_length=64)


def _version_key(version: str) -> tuple:
    match = SEMVER_RE.fullmatch(version)
    if not match:
        return (0, 0, 0, 0, 0, ((1, version),))
    major, minor, patch, prerelease = match.groups()
    identifiers = tuple((0, int(part)) if part.isdigit() else (1, part)
                        for part in (prerelease or '').split('.'))
    return (1, int(major), int(minor), int(patch), int(prerelease is None), identifiers)


def _manifest_version() -> str:
    try:
        return str(json.loads(MANIFEST.read_text()).get('version') or 'unknown')
    except (OSError, ValueError, TypeError):
        return 'unknown'


def _read_url(url: str, limit: int) -> bytes:
    request = urllib.request.Request(url, headers={'User-Agent': 'hermes-workbench', 'Accept': 'application/vnd.github+json' if '/api.github.com/' in url else 'application/octet-stream'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                data = response.read(limit + 1)
            break
        except OSError as exc:
            if attempt == 2 or (isinstance(exc, urllib.error.HTTPError) and exc.code < 500 and exc.code != 429):
                raise
            time.sleep(attempt + 1)
    if len(data) > limit:
        raise ValueError('Release response exceeds size limit')
    return data


def _github_releases() -> list[dict]:
    global _catalog
    with _catalog_lock:
        if time.monotonic() - _catalog[0] < 300:
            return _catalog[1]
        rows = []
        for page in range(1, 4):
            payload = json.loads(_read_url(f'https://api.github.com/repos/{REPOSITORY}/releases?per_page=100&page={page}', 4 * 1024 * 1024))
            if not isinstance(payload, list):
                raise ValueError('Invalid GitHub release catalog')
            for release in payload:
                version = str(release.get('tag_name', '')).removeprefix('v')
                if release.get('draft') or not VERSION_RE.fullmatch(version) or not SEMVER_RE.fullmatch(version):
                    continue
                names = {asset.get('name') for asset in release.get('assets', [])}
                if f'hermes-workbench-v{version}.tar.gz' not in names or 'SHA256SUMS' not in names:
                    continue
                rows.append({'version': version, 'ready': False, 'source': 'github',
                             'notes': str(release.get('body') or ''),
                             'published_at': release.get('published_at'),
                             'prerelease': bool(release.get('prerelease')),
                             'url': f'https://github.com/{REPOSITORY}/releases/tag/v{version}'})
            if len(payload) < 100:
                break
        _catalog = (time.monotonic(), rows)
        return rows


def _local_versions() -> list[dict]:
    rows = []
    store = managed_store()
    if store:
        if store.releases.exists():
            for p in store.releases.iterdir():
                if not p.is_symlink() and VERSION_RE.fullmatch(p.name) and (p / 'release.json').is_file():
                    rows.append({'version': p.name, 'ready': True, 'source': 'local', 'notes': ''})
        return rows
    if RELEASES.is_dir():
        for item in RELEASES.iterdir():
            if item.is_symlink() or not item.is_dir() or not VERSION_RE.fullmatch(item.name):
                continue
            if all((item / name).is_file() for name in ASSETS[:2]):
                rows.append({'version': item.name, 'ready': True, 'source': 'local', 'notes': ''})
    active = _manifest_version()
    if active != 'unknown' and not any(row['version'] == active for row in rows):
        rows.append({'version': active, 'ready': True, 'source': 'local', 'notes': ''})
    return rows


def _version_catalog() -> dict:
    store = managed_store()
    rows = {row['version']: row for row in _local_versions()}
    warning = None
    try:
        for row in _github_releases():
            if store and (row.get('prerelease') or _version_key(row['version']) < _version_key('0.8.0')):
                continue
            rows[row['version']] = {**row, 'ready': bool(rows.get(row['version'], {}).get('ready'))}
    except (OSError, ValueError, TypeError, KeyError) as exc:
        warning = 'GitHub 版本列表暂不可用，仍可切换本地版本。'
    return {'active': store.active() if store else _manifest_version(), 'update_mode': 'release' if store else 'development', 'update': store.status() if store else None, 'versions': sorted(rows.values(), key=lambda row: _version_key(row['version']), reverse=True), 'warning': warning}


def _download_release(version: str) -> Path:
    # Resolve against our fixed public repository, never an arbitrary client URL.
    if not any(row['version'] == version for row in _github_releases()):
        raise ValueError('Published Workbench version not found')
    name = f'hermes-workbench-v{version}.tar.gz'
    base = f'https://github.com/{REPOSITORY}/releases/download/v{version}/'
    checksums = _read_url(base + 'SHA256SUMS', 128 * 1024).decode()
    expected = next((parts[0] for line in checksums.splitlines()
                     if len(parts := line.split()) == 2 and parts[1] == name), None)
    if not expected or not re.fullmatch(r'[a-fA-F0-9]{64}', expected):
        raise ValueError('Release checksum missing')
    data = _read_url(base + name, 50 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != expected.lower():
        raise ValueError('Release checksum mismatch')
    store = managed_store()
    if store:
        return store.stage(data, version)
    RELEASES.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=RELEASES, prefix='.download-') as tmp:
        stage = Path(tmp)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            prefix = f'hermes-workbench-v{version}/'
            def read_member(name: str, limit: int) -> bytes:
                member = archive.getmember(prefix + name)
                if not member.isfile() or member.size > limit:
                    raise ValueError('Invalid release member')
                return archive.extractfile(member).read(limit + 1)
            manifest = json.loads(read_member('plugin/dashboard/manifest.json', 65536))
            metadata = json.loads(read_member('release.json', 65536))
            if manifest.get('version') != version or metadata.get('version') != version:
                raise ValueError('Release version mismatch')
            for asset in ASSETS:
                content = read_member('plugin/dashboard/dist/' + asset, 20 * 1024 * 1024)
                if not content:
                    raise ValueError('Empty release asset')
                (stage / asset).write_bytes(content)
                (stage / asset).chmod(0o664)
        target = RELEASES / version
        if target.exists():
            raise ValueError('Release directory already exists but is incomplete')
        stage.chmod(0o775)
        os.rename(stage, target)
    return target


def _atomic_install(source: Path, target: Path) -> None:
    fd, name = tempfile.mkstemp(prefix=f'.{target.name}.', dir=target.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        shutil.copyfile(source, temporary)
        temporary.chmod(0o664)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _switch(version: str) -> dict:
    if not VERSION_RE.fullmatch(version):
        raise HTTPException(400, 'Invalid Workbench version')
    if managed_store():
        try:
            return _switch_managed(version, managed_store())
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, f'完整版本准备失败，当前版本未切换：{exc}') from exc
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, '另一个版本正在切换，请稍后重试。')
    try:
        if version == _manifest_version():
            return {'active': version, 'ok': True}
        source = RELEASES / version
        if source.is_symlink():
            raise ValueError('Invalid local release directory')
        if not all((source / name).is_file() for name in ASSETS[:2]):
            source = _download_release(version)
        DIST.mkdir(parents=True, exist_ok=True)
        RELEASES.mkdir(parents=True, exist_ok=True)
        manifest = json.loads(MANIFEST.read_text())
        active = str(manifest.get('version', ''))
        # Keep the exact running assets for a user-selected rollback.
        if VERSION_RE.fullmatch(active):
            backup = RELEASES / active
            if backup.is_symlink():
                raise ValueError('Invalid rollback directory')
            backup.mkdir(exist_ok=True)
            for asset in ASSETS:
                if (DIST / asset).is_file():
                    _atomic_install(DIST / asset, backup / asset)
        assets = [name for name in ASSETS if (source / name).is_file()]
        with tempfile.TemporaryDirectory(dir=DIST, prefix='.rollback-') as tmp:
            rollback = Path(tmp)
            originals = {DIST / name: (DIST / name).exists() for name in assets}
            originals[MANIFEST] = True
            for target, existed in originals.items():
                if existed:
                    shutil.copy2(target, rollback / target.name)
            try:
                for name in assets:
                    _atomic_install(source / name, DIST / name)
                manifest['version'] = version
                updated = rollback / 'updated.json'
                updated.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
                _atomic_install(updated, MANIFEST)
            except OSError:
                for target, existed in originals.items():
                    if existed:
                        os.replace(rollback / target.name, target)
                    else:
                        target.unlink(missing_ok=True)
                raise
        return {'active': version, 'ok': True}
    except (OSError, ValueError, KeyError, tarfile.TarError) as exc:
        raise HTTPException(502, f'版本下载或切换失败，当前版本已保留：{exc}') from exc
    finally:
        _lock.release()


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get('/versions')
    async def versions() -> dict:
        return await asyncio.to_thread(_version_catalog)

    @router.get('/versions/update-status')
    async def update_status() -> dict:
        store = managed_store()
        return store.status() if store else {'phase': 'idle'}

    @router.post('/versions/switch')
    async def switch_version(body: VersionSwitch) -> dict:
        return await asyncio.to_thread(_switch, body.version.strip())

    return router
