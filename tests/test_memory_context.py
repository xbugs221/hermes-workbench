import os
import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dashboard"))
from memory_context import build_codex_memory_instructions


class MemoryContextContract(unittest.TestCase):
    def test_index_lists_topics_without_inlining_all_topic_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "memories"
            topics = root / "topics"
            topics.mkdir(parents=True)
            (topics / "frontend.md").write_text(
                "# Frontend delivery\nUse the deployed bundle.\n\nSensitive detail that should be read on demand.\n",
                encoding="utf-8",
            )
            old = os.environ.get("HERMES_HOME")
            os.environ["HERMES_HOME"] = temp
            try:
                instructions = build_codex_memory_instructions()
            finally:
                if old is None:
                    os.environ.pop("HERMES_HOME", None)
                else:
                    os.environ["HERMES_HOME"] = old
        self.assertIn(str(topics / "frontend.md"), instructions)
        self.assertIn("Do not read every topic at startup", instructions)
        self.assertNotIn("Sensitive detail that should be read on demand", instructions)


if __name__ == "__main__":
    unittest.main()
