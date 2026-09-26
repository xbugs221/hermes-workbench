#!/usr/bin/env python3
"""Reject common machine-specific paths, private endpoints and credential literals.

This is a review aid, not a guarantee of anonymization. Public repository URLs,
loopback addresses and third-party license/notice text are intentionally allowed.
"""
import ipaddress
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'host-specific path': re.compile(r'/volume\d+/(?:docker|homes|@appdata)/|/Users/[A-Za-z0-9][^/\s]*/'),
    'credential literal': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b'),
    'private key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
}
IPV4 = re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')


def findings(text):
    for line_no, line in enumerate(text.splitlines(), 1):
        for label, pattern in PATTERNS.items():
            if pattern.search(line):
                yield line_no, label
        for match in IPV4.finditer(line):
            try:
                address = ipaddress.ip_address(match.group())
            except ValueError:
                continue
            if address.is_private and not address.is_loopback and not address.is_unspecified:
                yield line_no, 'private network address'


def main():
    names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    files = [ROOT / name for name in names if name and (ROOT / name).is_file()]
    # Also inspect project-generated browser assets after building.
    dist = ROOT / 'dashboard/dist'
    if dist.exists():
        files.extend(p for p in dist.rglob('*') if p.is_file() and p.name != 'mermaid.min.js')
    errors = []
    for path in files:
        if path.name == 'pnpm-lock.yaml' or path.name.upper().startswith(('LICENSE', 'NOTICE', 'COPYING')):
            continue
        try:
            text = path.read_text()
        except (UnicodeError, OSError):
            continue
        errors.extend(f'{path.relative_to(ROOT)}:{line}: {label}' for line, label in findings(text))
    for error in errors:
        print(error, file=sys.stderr)  # Never echo matching credentials.
    if errors:
        return 1
    print(f'Public-content checks passed ({len(files)} files). Review personal names and contextual data separately.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
