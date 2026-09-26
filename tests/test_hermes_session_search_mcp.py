"""Adapter contract checks without private Hermes databases or installed source."""
import importlib.util
import json
import sqlite3
import sys
import types
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('recall', Path(__file__).parents[1] / 'dashboard/hermes_session_search_mcp.py')
recall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recall)


@pytest.fixture
def hermes(tmp_path, monkeypatch):
    path = tmp_path / 'state.db'
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE sessions (id TEXT)')
        db.execute("INSERT INTO sessions VALUES ('known')")
    monkeypatch.setenv('HERMES_WORKBENCH_HERMES_HOME', str(tmp_path))
    instances = []

    class SessionDB:
        def __init__(self, db_path, read_only):
            assert read_only is True
            self.conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            self.closed = False
            instances.append(self)

        def get_session(self, session_id):
            return self.conn.execute('SELECT id FROM sessions WHERE id=?', (session_id,)).fetchone()

        def close(self):
            self.conn.close()
            self.closed = True

    def search(**kwargs):
        with pytest.raises(sqlite3.OperationalError, match='readonly'):
            kwargs['db'].conn.execute('DELETE FROM sessions')
        return json.dumps({k: v for k, v in kwargs.items() if k != 'db'})

    monkeypatch.setitem(sys.modules, 'hermes_state', types.SimpleNamespace(SessionDB=SessionDB))
    monkeypatch.setitem(sys.modules, 'tools.session_search_tool', types.SimpleNamespace(session_search=search))
    return tmp_path, instances


def test_search_is_readonly_clamped_and_closed(hermes):
    _, instances = hermes
    data = json.loads(recall._search(query='Workbench', limit=100, window=-1, session_id='@session:known'))
    assert data['limit'] == 20
    assert data['window'] == 1
    assert data['session_id'] == 'known'
    assert instances[-1].closed


def test_missing_session_closes_database(hermes):
    _, instances = hermes
    with pytest.raises(ValueError, match='session not found'):
        recall._search(session_id='missing')
    assert instances[-1].closed


def test_profile_scope_rejects_escape(hermes):
    with pytest.raises(ValueError, match='invalid profile'):
        recall._profile_db('../escape')
    with pytest.raises(ValueError, match='conflicting'):
        recall._search(session_id='@session:other/known', profile='default')
    with pytest.raises(FileNotFoundError):
        recall._profile_db('missing')
