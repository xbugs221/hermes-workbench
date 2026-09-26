"""Release guards must survive minifier quote changes without losing coverage."""
from pathlib import Path
import subprocess

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify-release.sh"


def verify(tmp_path, bundle, missing_asset=None):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    script = scripts / SCRIPT.name
    script.write_bytes(SCRIPT.read_bytes())
    dist = tmp_path / "dashboard" / "dist"
    dist.mkdir(parents=True)
    for name, contents in {
        "index.js": bundle,
        "style.css": "body{}",
        "mermaid.min.js": "window.mermaid={}",
    }.items():
        if name != missing_asset:
            (dist / name).write_text(contents)
    return subprocess.run(["bash", str(script)], capture_output=True, text=True)


@pytest.mark.parametrize("quote", ['"', "'", "`"])
def test_accepts_minifier_quotes(tmp_path, quote):
    bundle = f'hermes.workbench.zh-dashboard;{{Achievements: {quote}成就{quote},kanban:{quote}看板{quote}}}'
    assert verify(tmp_path, bundle).returncode == 0


@pytest.mark.parametrize("bundle", [
    'hermes.workbench.zh-dashboard;{kanban:"看板"}',
    'hermes.workbench.zh-dashboard;{Achievements:"Achievements",kanban:"看板"}',
    'hermes.workbench.zh-dashboard;{Achievements:"成就"}',
    '{Achievements:"成就",kanban:"看板"}',
    'react.production;hermes.workbench.zh-dashboard;{Achievements:"成就",kanban:"看板"}',
])
def test_rejects_invalid_bundle(tmp_path, bundle):
    assert verify(tmp_path, bundle).returncode != 0


@pytest.mark.parametrize("asset", ["index.js", "style.css", "mermaid.min.js"])
def test_requires_all_assets(tmp_path, asset):
    bundle = 'hermes.workbench.zh-dashboard;{Achievements:"成就",kanban:"看板"}'
    assert verify(tmp_path, bundle, missing_asset=asset).returncode != 0
