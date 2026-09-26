"""Instances only import credentials from an explicitly configured source."""
import json
import os
from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / 'dashboard'))
import combined_runtime as runtime

@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_WORKBENCH_RUNTIME_UID', str(os.getuid()))
    monkeypatch.setenv('HERMES_WORKBENCH_RUNTIME_GID', str(os.getgid()))
    monkeypatch.setenv('CODEX_HOME', str(tmp_path))
    monkeypatch.setenv('CODEX_APP_SERVER_TOKEN_FILE', str(tmp_path / 'ws-token'))
    monkeypatch.delenv('HERMES_WORKBENCH_CODEX_AUTH_SOURCE', raising=False)
    monkeypatch.setattr(runtime.os, 'chown', lambda *_: None)
    return tmp_path

def test_missing_credentials_require_explicit_configuration(home):
    with pytest.raises(RuntimeError, match='Sign in with Codex'):
        runtime.seed_codex_credentials()
    assert not (home / 'auth.json').exists()

def test_existing_credentials_are_preserved(home):
    auth = home / 'auth.json'
    auth.write_text('{"existing": true}')
    runtime.seed_codex_credentials()
    assert auth.read_text() == '{"existing": true}'
    assert (home / 'ws-token').stat().st_mode & 0o777 == 0o600

def test_explicit_pool_seeds_only_this_instance(home, monkeypatch):
    source = home / 'pool.json'
    content = {'providers': {'openai-codex': {'tokens': ['test-only']}}}
    source.write_text(json.dumps(content))
    monkeypatch.setenv('HERMES_WORKBENCH_CODEX_AUTH_SOURCE', str(source))
    runtime.seed_codex_credentials()
    assert json.loads((home / 'auth.json').read_text()) == content['providers']['openai-codex']
    assert (home / 'auth.json').stat().st_mode & 0o777 == 0o600
    assert json.loads(source.read_text()) == content
