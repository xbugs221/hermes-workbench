#!/usr/bin/env python3
"""Prevent retired, unsanitized history from being merged back into the project."""
import argparse
import hashlib
from pathlib import Path
import subprocess

# SHA-256 digests of retired commit IDs; do not publish direct links to removed data.
RETIRED = frozenset(['70bce9074c87ba39fbeb9d39fde3922c54d63a079eedeb8c76dc0d5a7ff0040b', 'e4bf04d2c00f582d74a6efeefb8a2d5101ee66cdff98f972ded290b2fa61c856'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    if subprocess.check_output(['git', 'rev-parse', '--is-shallow-repository'], cwd=args.repository, text=True).strip() == 'true':
        raise SystemExit('History check requires a full clone (fetch-depth: 0).')
    revisions = subprocess.check_output(['git', 'rev-list', '--all'], cwd=args.repository).splitlines()
    if any(hashlib.sha256(commit).hexdigest() in RETIRED for commit in revisions):
        raise SystemExit('Retired repository history detected. Use a fresh clone and reapply only reviewed changes; do not merge an old clone.')
    print(f'History check passed ({len(revisions)} reachable commits).')


if __name__ == '__main__':
    main()
