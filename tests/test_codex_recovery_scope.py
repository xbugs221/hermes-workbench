"""Connecting must not recreate MCP workers for completed history."""
import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'dashboard'))
from codex_bridge import CodexBridge

class RecoveryScope(unittest.IsolatedAsyncioTestCase):
    async def test_connect_and_reconcile_only_unfinished_sessions(self):
        with tempfile.TemporaryDirectory() as d:
            bridge=CodexBridge(db_path=Path(d)/'db',workspace_map={},transport_factory=lambda endpoint:object())
            for status in ('idle','completed','interrupted','running','waiting','unknown'):
                bridge.store.upsert_session('qa','default',dict(session_id=status,thread_id='thread-'+status,
                    workspace_id='w',workspace_path=d,status=status))
            calls=[]
            class Peer:
                closed=False
                async def start(self):pass
                async def request(self,method,params):calls.append((method,params));return {}
                async def close(self):self.closed=True
            try:
                with patch('codex_bridge.JsonRpcConnection',return_value=Peer()):
                    await bridge._connection('qa','default')
                self.assertEqual({p['threadId'] for m,p in calls if m=='thread/resume'},
                                 {'thread-running','thread-waiting','thread-unknown'})
                read=[]
                async def history(user,profile,session_id,*args,**kwargs):read.append(session_id)
                bridge.history=history
                await bridge._recover_sessions('qa','default')
                self.assertEqual(set(read),{'running','waiting','unknown'})
            finally:await bridge.close()
