"""Verify that the Workbench transport accepts large Codex history frames."""

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dashboard"))

from codex_bridge import WebSocketJsonTransport


class WebSocketTransportContract(unittest.TestCase):
    """Protect connection options shared by authenticated and local endpoints."""

    def setUp(self) -> None:
        """Create a fake WebSocket connector that records every invocation."""

        self.calls: list[tuple[str, dict[str, object]]] = []
        self.socket = object()

        async def connect(endpoint: str, **options: object) -> object:
            """Record the endpoint and options without opening a network socket."""

            self.calls.append((endpoint, options))
            return self.socket

        self.websockets = SimpleNamespace(connect=connect)

    def test_local_connection_disables_default_receive_limit(self) -> None:
        """Allow thread snapshots larger than websockets' one MiB default."""

        with (
            patch.dict(sys.modules, {"websockets": self.websockets}),
            patch.dict(os.environ, {}, clear=False),
        ):
            os.environ.pop("CODEX_APP_SERVER_TOKEN_FILE", None)
            transport = asyncio.run(WebSocketJsonTransport.connect("ws://codex.test"))

        self.assertIs(transport.socket, self.socket)
        self.assertEqual(self.calls, [("ws://codex.test", {"max_size": None})])

    def test_authenticated_connection_keeps_header_and_disables_limit(self) -> None:
        """Preserve bearer authentication while accepting large snapshots."""

        with tempfile.TemporaryDirectory(prefix="workbench-transport-") as directory:
            token_file = Path(directory) / "token"
            token_file.write_text("test-token\n", encoding="utf-8")
            with (
                patch.dict(sys.modules, {"websockets": self.websockets}),
                patch.dict(os.environ, {"CODEX_APP_SERVER_TOKEN_FILE": str(token_file)}),
            ):
                transport = asyncio.run(WebSocketJsonTransport.connect("wss://codex.test"))

        self.assertIs(transport.socket, self.socket)
        self.assertEqual(
            self.calls,
            [
                (
                    "wss://codex.test",
                    {
                        "additional_headers": {"Authorization": "Bearer test-token"},
                        "max_size": None,
                    },
                )
            ],
        )


if __name__ == "__main__":
    unittest.main()
