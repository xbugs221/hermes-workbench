"""Exercise the real HTTP/schema/storage path with a deterministic upstream peer."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'dashboard'))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from codex_bridge import CodexBridge, RpcFailure, create_router


class SteerContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workbench-steer-')
        root = Path(self.temp.name)
        self.bridge = CodexBridge(db_path=root / 'bridge.db', workspace_root=root, workspace_map={})
        self.bridge.store.upsert_session('qa', 'default', {
            'session_id': 'session', 'thread_id': 'thread', 'workspace_id': 'workspace',
            'workspace_path': str(root), 'status': 'running',
        })
        self.calls = []
        self.fail = False
        owner = self

        class Peer:
            async def request(self, method, payload):
                owner.calls.append((method, payload))
                if owner.fail:
                    raise RpcFailure({'code': -32600, 'message': 'expected turn is no longer active'})
                return {'turnId': 'active-turn'} if method == 'turn/steer' else {'turn': {'id': 'new-turn', 'status': 'inProgress'}}

        async def connection(user, profile):
            return Peer()
        self.bridge._connection = connection
        app = FastAPI()
        app.include_router(create_router(self.bridge), prefix='/codex')
        self.client = TestClient(app)
        self.url = '/codex/session?profile=default&session_id=session'

    def tearDown(self):
        self.client.close()
        self.bridge.store.close()
        self.temp.cleanup()

    def post(self, request_id, **kwargs):
        return self.client.post(self.url, headers={'remote-user': 'qa'}, json={
            'clientRequestId': request_id, 'text': '调整任务方向', **kwargs,
        })

    def test_steer_preserves_active_turn_and_idempotency_without_overrides(self):
        self.url = self.url.replace('/session?', '/session/steer?')
        self.assertEqual(self.post('missing-turn').status_code, 422)
        first = self.post('request-1', expectedTurnId='active-turn', model='ignored', effort='high')
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()['request']['turn_id'], 'active-turn')
        self.assertEqual(first.json()['request']['status'], 'accepted')
        self.assertEqual(self.post('request-1', expectedTurnId='active-turn').json(), first.json())
        self.assertEqual(len(self.calls), 1)
        method, payload = self.calls[0]
        self.assertEqual(method, 'turn/steer')
        self.assertEqual(set(payload), {'threadId', 'clientUserMessageId', 'input', 'expectedTurnId'})
        self.assertEqual(payload['expectedTurnId'], 'active-turn')
        self.url = self.url.replace('/session/steer?', '/session?')
        self.post('request-2', model='chosen-model')
        self.assertEqual(self.calls[-1][0], 'turn/start')
        self.assertEqual(self.calls[-1][1]['model'], 'chosen-model')

    def test_stale_steer_never_falls_back_or_retries_and_enforces_ownership(self):
        self.fail = True
        failed = self.post('stale-request', expectedTurnId='old-turn')
        self.assertEqual(failed.json()['request']['status'], 'failed')
        self.post('stale-request', expectedTurnId='old-turn')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0], 'turn/steer')
        response = self.client.post(self.url, headers={'remote-user': 'someone-else'}, json={
            'clientRequestId': 'foreign', 'text': 'no', 'expectedTurnId': 'active-turn',
        })
        self.assertEqual(response.status_code, 404)
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()
