"""Creation failures must remain recoverable without sending placeholder IDs."""
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'dashboard'))
from codex_bridge import CodexBridge, RpcFailure, UnknownAcceptance
from fastapi import HTTPException


class SessionCreationContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.bridge = CodexBridge(db_path=root / 'db', workspace_root=root, workspace_map={})
        self.calls = []
        self.failure = None
        self.connection_failure = None
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()
        owner = self

        class Peer:
            async def request(self, method, params):
                owner.calls.append((method, params))
                if method == 'thread/start':
                    owner.started.set()
                    await owner.release.wait()
                    if owner.failure:
                        raise owner.failure
                    return {'thread': {'id': 'valid-thread'}}
                owner.assertEqual(method, 'turn/start')
                owner.assertEqual(params['threadId'], 'valid-thread')
                return {'turn': {'id': 'turn', 'status': 'inProgress'}}

        async def connection(*args):
            if owner.connection_failure:
                raise owner.connection_failure
            return Peer()
        self.bridge._connection = connection
        self.values = {'session_id': 'session', 'model': 'chosen', 'effort': 'medium'}

    async def asyncTearDown(self):
        await self.bridge.close()
        self.temp.cleanup()

    def session(self):
        return self.bridge.store.session('qa', 'default', 'session')

    async def create(self):
        return await self.bridge.create_session('qa', 'default', self.values)

    async def test_timeout_is_not_success_and_retry_resolves_same_session(self):
        self.failure = UnknownAcceptance('connection closed')
        with self.assertRaises(HTTPException) as caught:
            await self.create()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(self.session()['status'], 'unknown')
        self.failure = None
        result = await self.create()
        self.assertEqual(result['thread_id'], 'valid-thread')
        self.assertEqual(result['session_id'], 'session')
        self.assertIn('Persistent Hermes memory', self.calls[-1][1]['developerInstructions'])
        self.assertIn('/opt/data/memories', self.calls[-1][1]['developerInstructions'])
        await self.create()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[-1][1]['reasoningEffort'], 'medium')

    async def test_connection_failure_and_rpc_rejection_persist_recoverable_state(self):
        self.connection_failure = OSError('offline')
        with self.assertRaises(HTTPException):
            await self.create()
        self.assertEqual(self.session()['status'], 'unknown')
        self.connection_failure = None
        self.failure = RpcFailure({'code': -1, 'message': 'rejected'})
        with self.assertRaises(HTTPException):
            await self.create()
        self.assertEqual(self.session()['status'], 'failed')
        self.failure = None
        self.assertEqual((await self.create())['status'], 'idle')

    async def test_cancelled_creation_does_not_leave_starting_forever(self):
        self.release.clear()
        task = asyncio.create_task(self.create())
        await self.started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.session()['status'], 'unknown')
        self.release.set()
        await self.create()
        self.assertEqual(self.session()['thread_id'], 'valid-thread')

    async def test_legacy_placeholder_history_and_duplicate_submission_recover(self):
        self.failure = UnknownAcceptance('timeout')
        with self.assertRaises(HTTPException):
            await self.create()
        self.bridge.store.save_request('qa', 'default', 'session', 'first', status='failed',
            payload=json.dumps({'threadId': 'pending:session', 'input': [{'type': 'text', 'text': 'original'}]}),
            result=json.dumps({'message': 'invalid thread id: found p'}))
        snapshot = await self.bridge.history('qa', 'default', 'session', 0, 100)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(snapshot['pendingRequests'][0]['payload']['input'][0]['text'], 'original')
        self.assertFalse(self.bridge.store.has_submission('qa', 'default', 'session'))
        self.failure = None
        values = {'clientRequestId': 'first', 'text': 'original'}
        results = await asyncio.gather(*[self.bridge.submit('qa', 'default', 'session', values) for _ in range(2)])
        self.assertTrue(all(result['status'] == 'accepted' for result in results))
        self.assertTrue(self.bridge.store.has_submission('qa', 'default', 'session'))
        self.assertEqual([method for method, _ in self.calls], ['thread/start', 'thread/start', 'turn/start'])

    async def test_unknown_turn_is_never_replayed(self):
        await self.create()
        self.bridge.store.save_request('qa', 'default', 'session', 'first', status='unknown', payload='{}')
        result = await self.bridge.submit('qa', 'default', 'session', {'clientRequestId': 'first', 'text': 'original'})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(len(self.calls), 1)

    async def test_concurrent_create_and_send_wait_for_real_thread(self):
        self.release.clear()
        creation = asyncio.create_task(self.create())
        await self.started.wait()
        send = asyncio.create_task(self.bridge.submit('qa', 'default', 'session', {'clientRequestId': 'first', 'text': 'hello'}))
        await asyncio.sleep(0)
        self.assertFalse(send.done())
        self.release.set()
        await asyncio.gather(creation, send)
        self.assertEqual([method for method, _ in self.calls], ['thread/start', 'turn/start'])


if __name__ == '__main__':
    unittest.main()
