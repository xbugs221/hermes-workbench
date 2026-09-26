"""An unloaded persisted thread can accept a new turn without duplicate sends."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'dashboard'))
from codex_bridge import CodexBridge, RpcFailure, UnknownAcceptance


class SubmitRecovery(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, errors, expected, *, steer=False):
        with tempfile.TemporaryDirectory() as directory:
            bridge = CodexBridge(db_path=Path(directory) / 'db', workspace_map={})
            bridge.store.upsert_session('qa', 'default', dict(
                session_id='session', thread_id='thread', workspace_id='w',
                workspace_path=directory, status='completed'))
            calls = []

            class Peer:
                async def request(self, method, payload):
                    calls.append((method, dict(payload)))
                    error = errors.pop(0) if errors else None
                    if error:
                        raise error
                    return {'turn': {'id': 'turn', 'status': 'completed'}}

            async def connection(*args):
                return Peer()

            bridge._connection = connection
            values = {'clientRequestId': 'request', 'text': 'hello'}
            if steer:
                values['expectedTurnId'] = 'active'
            try:
                first = await bridge.submit('qa', 'default', 'session', values)
                self.assertEqual(first['status'], expected)
                self.assertEqual(await bridge.submit('qa', 'default', 'session', values), first)
                return calls
            finally:
                await bridge.close()

    def missing(self):
        return RpcFailure({'code': -32600, 'message': 'thread not found: thread'})

    async def test_recovers_once_and_preserves_input_and_idempotency(self):
        calls = await self.exercise([self.missing()], 'accepted')
        self.assertEqual([m for m, _ in calls], ['turn/start', 'thread/resume', 'turn/start'])
        self.assertEqual(calls[0][1], calls[2][1])

    async def test_second_rejection_is_not_retried(self):
        calls = await self.exercise([self.missing(), None, self.missing()], 'failed')
        self.assertEqual(len(calls), 3)

    async def test_steer_and_unrelated_failures_are_not_replayed(self):
        for error, steer in [(self.missing(), True), (RpcFailure({'code': -32600, 'message': 'other error'}), False)]:
            calls = await self.exercise([error], 'failed', steer=steer)
            self.assertEqual(len(calls), 1)

    async def test_uncertain_acceptance_is_not_replayed(self):
        calls = await self.exercise([UnknownAcceptance('timeout')], 'unknown')
        self.assertEqual(len(calls), 1)
        calls = await self.exercise([self.missing(), None, UnknownAcceptance('timeout')], 'unknown')
        self.assertEqual(len(calls), 3)

    async def test_failed_resume_does_not_send(self):
        calls = await self.exercise([self.missing(), self.missing()], 'failed')
        self.assertEqual([m for m, _ in calls], ['turn/start', 'thread/resume'])
