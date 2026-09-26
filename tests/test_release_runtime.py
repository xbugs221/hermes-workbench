"""Exercise real release activation, failed backend rollback, and crash recovery."""
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import time

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / 'dashboard'))
from release_runtime import ReleaseController, ReleaseStore, write_json, stop_sidecar
import workbench_version_manager as versions


def release(store, version, broken=False):
    target = store.target(version)
    target.mkdir(parents=True)
    app = ('raise RuntimeError("deliberately broken test release")' if broken else f'''
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, sys
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps({{'version': '{version}'}}).encode())
 def log_message(self,*args):pass
HTTPServer.allow_reuse_address=True
HTTPServer(('127.0.0.1',int(sys.argv[1])),Handler).serve_forever()
''')
    files = {
        'plugin/dashboard/manifest.json': json.dumps({'version': version}),
        'sidecar/dashboard/manifest.json': json.dumps({'version': version}),
        'sidecar/dashboard/sidecar_app.py': app,
        'sidecar/dashboard/workbench_version_manager.py': 'test fixture',
        'sidecar/dashboard/release_runtime.py': 'test fixture',
        'plugin/dashboard/dist/index.js': 'loader', 'plugin/dashboard/dist/style.css': 'loader-css',
        'plugin/dashboard/dist/workbench.js': 'js', 'plugin/dashboard/dist/workbench.css': 'css',
        'plugin/dashboard/dist/mermaid.min.js': 'mermaid',
        'sidecar/dashboard/dist/index.js': 'js', 'sidecar/dashboard/dist/style.css': 'css',
    }
    for name, text in files.items():
        p = target / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    (target / 'release.json').write_text(json.dumps({'version': version, 'runtime_abi': 1}))
    (target / 'release-files.json').write_text(json.dumps({k: hashlib.sha256(v.encode()).hexdigest() for k, v in files.items()}))
    return target


@pytest.fixture
def store(tmp_path):
    return ReleaseStore(tmp_path / 'runtime')


def test_real_process_activation_and_failed_release_rollback(store):
    for version in ['1.0.0', '1.1.0', '1.2.0']:
        release(store, version, broken=version == '1.2.0')
    store.activate('1.0.0')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    command = [sys.executable, str(store.current / 'sidecar/dashboard/sidecar_app.py'), str(port)]
    controller = ReleaseController(store, command, f'http://127.0.0.1:{port}/health')
    untouched_codex = object()
    processes = [subprocess.Popen(command), untouched_codex]
    try:
        controller.wait_healthy(processes[0], '1.0.0', timeout=10)
        for version, expected, phase in [('1.1.0', '1.1.0', 'succeeded'), ('1.2.0', '1.1.0', 'failed'), ('1.0.0', '1.0.0', 'succeeded')]:
            write_json(store.job, {'id': version, 'phase': 'queued', 'version': version,
                                  'previous': store.active(), 'created_at': time.time() - 3})
            controller.apply_pending(processes)
            assert store.active() == expected
            assert store.status()['phase'] == phase
            assert processes[1] is untouched_codex
            assert json.loads((store.current / 'plugin/dashboard/manifest.json').read_text())['version'] == expected
    finally:
        stop_sidecar(processes[0])


@pytest.mark.parametrize('phase', ['preparing', 'queued', 'activating'])
def test_interrupted_update_recovers_previous_release(store, phase):
    release(store, '1.0.0');release(store, '1.1.0')
    store.activate('1.1.0')
    write_json(store.job, {'phase': phase, 'previous': '1.0.0', 'version': '1.1.0'})
    store.recover()
    assert store.active() == '1.0.0'
    assert store.status()['phase'] == 'failed'


def archive(path, extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        tar.add(path, arcname='hermes-workbench-v1.0.0')
        if extra:
            info = tarfile.TarInfo('hermes-workbench-v1.0.0/' + extra)
            info.size = 1
            tar.addfile(info, io.BytesIO(b'x'))
    return output.getvalue()


def test_verified_archive_and_cache_revalidation(store, tmp_path):
    source = release(ReleaseStore(tmp_path / 'source'), '1.0.0')
    store.stage(archive(source), '1.0.0')
    file = store.target('1.0.0') / 'sidecar/dashboard/sidecar_app.py'
    file.chmod(0o644)
    file.write_text('tampered')
    with pytest.raises(ValueError, match='checksum'):
        store.stage(archive(source), '1.0.0')


@pytest.mark.parametrize('extra', ['../../escape', '/absolute', 'plugin/dashboard/manifest.json'])
def test_rejects_escape_and_duplicate_members(store, tmp_path, extra):
    source = release(ReleaseStore(tmp_path / 'source'), '1.0.0')
    with pytest.raises(ValueError):
        store.stage(archive(source, extra), '1.0.0')
    assert not store.target('1.0.0').exists()


def test_rejects_incompatible_runtime_without_activation(store):
    p = release(store, '1.0.0')
    (p / 'release.json').write_text(json.dumps({'version': '1.0.0', 'runtime_abi': 999}))
    with pytest.raises(ValueError):store.validate('1.0.0')
    assert not store.current.exists()


def test_managed_queue_busy_guard_and_write_admission(store, monkeypatch):
    release(store, '1.0.0');release(store, '1.1.0');store.activate('1.0.0')
    monkeypatch.setenv('WORKBENCH_RELEASE_HOME', str(store.root))
    async def busy():return True
    monkeypatch.setattr(versions, '_codex_busy', busy)
    with pytest.raises(versions.HTTPException) as exc:versions._switch('1.1.0')
    assert exc.value.status_code == 409
    assert store.active() == '1.0.0'
    assert not versions.update_pending()
    async def idle():return False
    monkeypatch.setattr(versions, '_codex_busy', idle)
    assert versions.begin_mutation()
    try:
        with pytest.raises(versions.HTTPException) as exc:versions._switch('1.1.0')
        assert exc.value.status_code == 409
    finally:versions.end_mutation()
    result = versions._switch('1.1.0')
    assert result['pending'] and store.active() == '1.0.0'
    assert not versions.begin_mutation()
    with pytest.raises(versions.HTTPException) as exc:versions._switch('1.1.0')
    assert exc.value.status_code == 409
