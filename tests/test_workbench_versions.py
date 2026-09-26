"""Version precedence, verified release downloads and non-destructive switches."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile

from fastapi import HTTPException
import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / 'dashboard'))
import workbench_version_manager as versions


@pytest.fixture
def home(tmp_path, monkeypatch):
    dist = tmp_path / 'dist'
    dist.mkdir()
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({'version': '0.6.43-codex.14', 'name': 'workbench'}))
    for name in versions.ASSETS:
        (dist / name).write_text('old-' + name)
    monkeypatch.setattr(versions, 'DIST', dist)
    monkeypatch.setattr(versions, 'MANIFEST', manifest)
    monkeypatch.setattr(versions, 'RELEASES', tmp_path / 'releases')
    monkeypatch.setattr(versions, '_catalog', (0, []))
    return tmp_path


def bundle(version='0.7.0'):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as archive:
        files = {'release.json': json.dumps({'version': version}),
                 'plugin/dashboard/manifest.json': json.dumps({'version': version})}
        files.update({'plugin/dashboard/dist/' + name: 'new-' + name for name in versions.ASSETS})
        for name, value in files.items():
            encoded = value.encode()
            member = tarfile.TarInfo(f'hermes-workbench-v0.7.0/{name}')
            member.size = len(encoded)
            archive.addfile(member, io.BytesIO(encoded))
    return data.getvalue()


def setup_remote(monkeypatch, data=None, wrong_hash=False):
    data = data or bundle()
    monkeypatch.setattr(versions, '_github_releases', lambda: [{'version': '0.7.0', 'notes': 'Changes', 'source': 'github'}])
    checksum = '0' * 64 if wrong_hash else hashlib.sha256(data).hexdigest()
    def fetch(url, limit):
        if url.endswith('SHA256SUMS'):
            return f'{checksum}  hermes-workbench-v0.7.0.tar.gz\n'.encode()
        return data
    monkeypatch.setattr(versions, '_read_url', fetch)


def test_semver_order():
    values = ['0.6.43-codex.9', '0.7.0-rc.2', '0.6.43-codex.14', '0.7.0', '0.7.0-rc.10', '0.10.0']
    assert sorted(values, key=versions._version_key, reverse=True) == ['0.10.0', '0.7.0', '0.7.0-rc.10', '0.7.0-rc.2', '0.6.43-codex.14', '0.6.43-codex.9']


def test_catalog_deduplicates_and_keeps_notes(home, monkeypatch):
    setup_remote(monkeypatch)
    versions._download_release('0.7.0')
    result = versions._version_catalog()
    assert len(result['versions']) == 2
    assert result['versions'][0]['version'] == '0.7.0'
    assert result['versions'][0]['notes'] == 'Changes'
    assert result['versions'][0]['ready']


def test_offline_catalog_retains_local_versions(home, monkeypatch):
    monkeypatch.setattr(versions, '_github_releases', lambda: (_ for _ in ()).throw(OSError('offline')))
    result = versions._version_catalog()
    assert result['warning']
    assert result['versions'][0]['version'] == '0.6.43-codex.14'


def test_manual_switch_downloads_and_retains_rollback(home, monkeypatch):
    setup_remote(monkeypatch)
    assert versions._switch('0.7.0')['active'] == '0.7.0'
    assert versions._manifest_version() == '0.7.0'
    assert (versions.DIST / 'mermaid.min.js').read_text() == 'new-mermaid.min.js'
    versions._switch('0.6.43-codex.14')
    assert (versions.DIST / 'workbench.js').read_text() == 'old-workbench.js'
    assert versions._manifest_version() == '0.6.43-codex.14'


@pytest.mark.parametrize('kind', ['checksum', 'version'])
def test_rejects_invalid_release_without_installing(home, monkeypatch, kind):
    setup_remote(monkeypatch, data=bundle('wrong' if kind == 'version' else '0.7.0'), wrong_hash=kind == 'checksum')
    with pytest.raises(HTTPException):
        versions._switch('0.7.0')
    assert versions._manifest_version() == '0.6.43-codex.14'
    assert (versions.DIST / 'workbench.js').read_text() == 'old-workbench.js'


def test_failed_install_rolls_back_assets_and_manifest(home, monkeypatch):
    setup_remote(monkeypatch)
    install = versions._atomic_install
    def fail_css(source, target):
        if target == versions.DIST / 'workbench.css':
            raise OSError('simulated disk error')
        install(source, target)
    monkeypatch.setattr(versions, '_atomic_install', fail_css)
    with pytest.raises(HTTPException):
        versions._switch('0.7.0')
    assert versions._manifest_version() == '0.6.43-codex.14'
    for name in versions.ASSETS:
        assert (versions.DIST / name).read_text() == 'old-' + name


def test_rejects_path_escape(home):
    with pytest.raises(HTTPException) as exc:
        versions._switch('../outside')
    assert exc.value.status_code == 400


def test_concurrent_switch_rejected(home):
    with versions._lock:
        with pytest.raises(HTTPException) as exc:
            versions._switch('0.7.0')
    assert exc.value.status_code == 409
