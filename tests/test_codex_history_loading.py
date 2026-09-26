"""Cold snapshots must not wait for archive fsync or duplicate upstream reads."""
import asyncio
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'dashboard'))
from codex_bridge import CodexBridge, RpcFailure
from fastapi import HTTPException


class HistoryLoadingContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bridge = CodexBridge(db_path=Path(self.temp.name) / 'db', workspace_map={})
        self.bridge.store.upsert_session('qa', 'default', {
            'session_id': 'session', 'thread_id': 'thread', 'workspace_id': 'workspace',
            'workspace_path': self.temp.name, 'status': 'completed',
        })
        self.calls = 0
        self.read_started = asyncio.Event()
        self.release_read = asyncio.Event()
        self.race = False
        owner = self

        class Peer:
            epoch = 'test-epoch'
            async def request(self, method, params):
                owner.calls += 1
                owner.assertEqual(method, 'thread/read')
                owner.read_started.set()
                await owner.release_read.wait()
                if owner.race:
                    owner.bridge.store.append_event('qa', 'default', 'session', 'item/completed', {
                        'method': 'item/completed', 'params': {'turnId': 'turn', 'item': {'id': 'racing', 'type': 'agentMessage', 'text': 'race'}},
                    })
                return {'thread': {'turns': [{'id': 'turn', 'status': 'completed', 'itemsView': 'full',
                    'items': [{'id': 'answer', 'type': 'agentMessage', 'text': '已完成'}]}]}}
            async def drain_notifications(self):
                pass
        async def connection(*args):
            return Peer()
        self.bridge._connection = connection

    async def asyncTearDown(self):
        self.release_read.set()
        await self.bridge.close()
        self.temp.cleanup()

    async def test_concurrent_readers_share_work_and_cancellation_does_not_abort_peer(self):
        first = asyncio.create_task(self.bridge.history('qa', 'default', 'session', 0, 200))
        await self.read_started.wait()
        second = asyncio.create_task(self.bridge.history('qa', 'default', 'session', 0, 200))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.release_read.set()
        result = await second
        self.assertEqual(self.calls, 1)
        self.assertEqual(len(result['turns']), 1)
        self.assertEqual(result['snapshotEvents'], [])
        # No stale result cache: the next request reads upstream again.
        await self.bridge.history('qa', 'default', 'session', 0, 200)
        self.assertEqual(self.calls, 2)
        with self.assertRaises(HTTPException) as raised:
            await self.bridge.history('other', 'default', 'session', 0, 200)
        self.assertEqual(raised.exception.status_code, 404)

    async def test_pristine_idle_session_does_not_query_native_history(self):
        """A brand-new empty thread gets a local snapshot before first submit."""
        self.bridge.store.upsert_session('qa', 'default', {
            'session_id': 'fresh', 'thread_id': 'fresh-thread', 'workspace_id': 'workspace',
            'workspace_path': self.temp.name, 'status': 'idle',
        })

        async def unexpected_connection(*args):
            raise AssertionError('empty session must not query the app-server')

        self.bridge._connection = unexpected_connection
        result = await self.bridge.history('qa', 'default', 'fresh', 0, 200)
        self.assertEqual(result['turns'], [])
        self.assertEqual(result['events'], [])
        self.assertEqual(result['snapshotEvents'], [])

    async def test_first_snapshot_precedes_fsync_but_archive_still_completes(self):
        started, release = threading.Event(), threading.Event()
        original = self.bridge.store.append_events
        def blocked(entries):
            started.set()
            if not release.wait(10):
                raise RuntimeError('archive test gate timed out')
            return original(entries)
        self.bridge.store.append_events = blocked
        self.release_read.set()
        try:
            result = await asyncio.wait_for(self.bridge.history('qa', 'default', 'session', 0, 200, defer_persistence=True), 2)
            self.assertEqual(result['turns'][0]['items'][0]['text'], '已完成')
            self.assertFalse(release.is_set())
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            self.assertEqual(result['snapshotEvents'], [])
        finally:
            release.set()
        while self.bridge._observer_tasks:
            await asyncio.gather(*tuple(self.bridge._observer_tasks))
        methods = [event['method'] for event in self.bridge.store.events('qa', 'default', 'session', 0, 200)]
        self.assertIn('history/item', methods)
        self.assertIn('history/turn', methods)

    async def test_snapshot_keeps_live_events_racing_read_without_duplicate_archive(self):
        self.release_read.set()
        self.race = True
        result = await self.bridge.history('qa', 'default', 'session', 0, 200)
        self.assertEqual([e['method'] for e in result['snapshotEvents']], ['item/completed'])
        self.assertGreaterEqual(result['snapshotSeq'], result['snapshotEvents'][0]['seq'])

    async def test_idle_native_thread_is_resumed_after_a_read_failure(self):
        owner = self

        class Peer:
            epoch = 'test-epoch'
            def __init__(self):
                self.methods = []
            async def request(self, method, params):
                self.methods.append(method)
                if self.methods == ['thread/read']:
                    raise RpcFailure({'message': 'thread is not loaded'})
                if method == 'thread/resume':
                    return {'thread': {'id': 'thread'}}
                owner.assertEqual(self.methods, ['thread/read', 'thread/resume', 'thread/read'])
                return {'thread': {'turns': [{'id': 'turn', 'status': 'completed', 'itemsView': 'full', 'items': []}]}}
            async def drain_notifications(self):
                pass

        peer = Peer()
        async def connection(*args):
            return peer
        self.bridge._connection = connection
        self.release_read.set()
        result = await self.bridge.history('qa', 'default', 'session', 0, 200)
        self.assertEqual(len(result['turns']), 1)
        self.assertEqual(peer.methods, ['thread/read', 'thread/resume', 'thread/read'])


if __name__ == '__main__':
    unittest.main()
