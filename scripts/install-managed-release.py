#!/usr/bin/env python3
"""One-time administrator migration. Stop the sidecar and back up user data first."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'dashboard'))
from release_runtime import ReleaseStore

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--sha256', required=True)
parser.add_argument('--version', required=True)
parser.add_argument('--root', type=Path, default=Path('/opt/data/workbench'))
parser.add_argument('--plugin-root', type=Path, default=Path('/opt/data/plugins/workbench'))
parser.add_argument('--uid', type=int, required=True)
parser.add_argument('--gid', type=int, required=True)
args = parser.parse_args()
data = args.archive.read_bytes()
if hashlib.sha256(data).hexdigest() != args.sha256:
    raise SystemExit('Archive checksum mismatch')
store = ReleaseStore(args.root)
if store.current.exists() or store.current.is_symlink():
    raise SystemExit('Already managed: use the frontend updater; do not reinstall over live state')
release = store.stage(data, args.version)
bootstrap = args.root / 'bootstrap'
bootstrap.mkdir(exist_ok=False)
for name in ['combined_runtime.py', 'release_runtime.py', 'sidecar_entrypoint.sh']:
    shutil.copyfile(release / 'sidecar/dashboard' / name, bootstrap / name)
    (bootstrap / name).chmod(0o444)
bootstrap.chmod(0o555)
for parent in [args.root, store.releases]:
    os.chown(parent, args.uid, args.gid)
    parent.chmod(0o775)
for path in [release, *release.rglob('*')]:
    os.chown(path, args.uid, args.gid)
store.activate(args.version)
# Existing browser paths remain stable, but now resolve through the same release as the backend.
dashboard = args.plugin_root / 'dashboard'
backup = args.root / 'migration-backup'
backup.mkdir(mode=0o700, exist_ok=False)
if dashboard.exists() or dashboard.is_symlink():
    dashboard.rename(backup / 'dashboard')
try:
    dashboard.parent.mkdir(parents=True, exist_ok=True)
    dashboard.symlink_to(store.current / 'plugin/dashboard', target_is_directory=True)
except Exception:
    if (backup / 'dashboard').exists():
        (backup / 'dashboard').rename(dashboard)
    store.current.unlink(missing_ok=True)
    raise
print(f'Managed release {args.version} installed; start the sidecar using {bootstrap}/combined_runtime.py')
