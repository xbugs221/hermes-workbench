#!/usr/bin/env python3
"""Publish built browser assets for a developer instance; never write into a managed release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path, help='Dashboard directory containing manifest.json and dist/')
parser.add_argument('--target', type=Path, default=Path(os.environ.get('HERMES_WORKBENCH_PLUGIN_ROOT', '/opt/data/plugins/workbench')) / 'dashboard')
parser.add_argument('--backup-root', type=Path, default=Path(os.environ.get('HERMES_WORKBENCH_HERMES_HOME', '/opt/data')) / 'state/workbench-dev-publish')
args = parser.parse_args()
target = args.target
if target.is_symlink() or not (target / 'dist/index.js').is_file():
    raise SystemExit('Expected an existing developer plugin, not a managed release or missing loader')
backup = args.backup_root / str(time.time_ns())
backup.mkdir(parents=True)
files = {'dist/workbench.js': args.source / 'dist/index.js',
         'dist/workbench.css': args.source / 'dist/style.css',
         'dist/mermaid.min.js': args.source / 'dist/mermaid.min.js',
         'manifest.json': args.source / 'manifest.json'}
# Validate every input before replacing any live file.
for path in files.values():
    if not path.is_file() or path.stat().st_size == 0:raise SystemExit(f'Missing build asset: {path}')
originals = {}
try:
    for name, source in files.items():
        dest = target / name
        originals[name] = dest.exists()
        old = backup / name;old.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():shutil.copy2(dest, old)
        with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as f:temp=Path(f.name)
        shutil.copyfile(source, temp);temp.chmod(0o664)
        owner = dest.stat() if dest.exists() else dest.parent.stat()
        if os.geteuid() == 0:os.chown(temp, owner.st_uid, owner.st_gid)
        temp.replace(dest)
    for name, source in files.items():
        assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256((target/name).read_bytes()).digest()
except Exception:
    for name, existed in originals.items():
        if existed:shutil.copy2(backup/name,target/name)
        else:(target/name).unlink(missing_ok=True)
    raise
print(json.dumps({'backup': str(backup), 'installed_hashes': {name: hashlib.sha256((target/name).read_bytes()).hexdigest() for name in files}}))
print('Files verified. Authenticated browser loading and interaction still need verification.')
