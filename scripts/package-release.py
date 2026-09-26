#!/usr/bin/env python3
"""Build the installable loader/runtime layout and auditable source archives."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

root = Path(__file__).resolve().parents[1]
version = subprocess.check_output(['python3', str(root / 'scripts/version.py'), '--check'], text=True).strip()
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=root, text=True).strip():
    raise SystemExit('Commit tracked changes before packaging: archive and release.json must match HEAD')
out = root / 'release'
out.mkdir(exist_ok=True)
name = f'hermes-workbench-v{version}'
with tempfile.TemporaryDirectory() as tmp:
    stage = Path(tmp) / name
    plugin = stage / 'plugin/dashboard'
    dist = plugin / 'dist'
    dist.mkdir(parents=True)
    for src, dst in [('loader.js', 'index.js'), ('loader.css', 'style.css'),
                     ('dist/index.js', 'workbench.js'), ('dist/style.css', 'workbench.css'),
                     ('dist/mermaid.min.js', 'mermaid.min.js')]:
        shutil.copy2(root / 'dashboard' / src, dist / dst)
    shutil.copy2(root / 'dashboard/manifest.json', plugin / 'manifest.json')
    # Backend sources and canonical browser files remain separate from the host loader.
    for src in (root / 'dashboard').glob('*.py'):
        shutil.copy2(src, plugin / src.name)
    sidecar = stage / 'sidecar/dashboard'
    shutil.copytree(root / 'dashboard', sidecar, ignore=shutil.ignore_patterns('src', '__pycache__', '*.pyc'))
    for folder in ['theme', 'extensions']:
        if (root / folder).exists():
            shutil.copytree(root / folder, stage / folder)
    for filename in ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'requirements-dev.txt']:
        shutil.copy2(root / filename, stage / filename)
    shutil.copytree(root / 'docs', stage / 'docs')
    # Preserve upstream license texts, including transitive bundled dependencies.
    licenses = stage / 'third-party-licenses'
    for source in (root / 'node_modules').rglob('*'):
        if source.is_file() and source.name.lower().startswith(('license', 'licence', 'notice', 'copying')):
            relative = source.relative_to(root / 'node_modules')
            target = licenses / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    (stage / 'release.json').write_text(json.dumps({'version': version, 'commit': commit, 'runtime_abi': 1}, indent=2) + '\n')
    hashes = {str(p.relative_to(stage)): hashlib.sha256(p.read_bytes()).hexdigest()
              for folder in ['plugin', 'sidecar'] for p in (stage / folder).rglob('*') if p.is_file()}
    (stage / 'release-files.json').write_text(json.dumps(hashes, indent=2) + '\n')
    with tarfile.open(out / f'{name}.tar.gz', 'w:gz') as archive:
        archive.add(stage, arcname=name)
subprocess.run(['git', 'archive', '--format=tar.gz', f'--prefix={name}-source/',
                '-o', str(out / f'{name}-source.tar.gz'), 'HEAD'], cwd=root, check=True)
assets = sorted(out.glob(f'{name}*.tar.gz'))
(out / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in assets))
print(out)
