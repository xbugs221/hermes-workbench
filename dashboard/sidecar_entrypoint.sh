#!/bin/sh
# Give the numeric bind-mount owner a real passwd identity, then drop root.
set -eu

runtime_uid="${HERMES_WORKBENCH_RUNTIME_UID:?missing runtime uid}"
runtime_gid="${HERMES_WORKBENCH_RUNTIME_GID:?missing runtime gid}"
passwd_file="${HERMES_WORKBENCH_PASSWD_FILE:-/etc/passwd}"

python3 - "$passwd_file" "$runtime_uid" "$runtime_gid" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
uid, gid = sys.argv[2:4]
lines = path.read_text(encoding="utf-8").splitlines()
updated = []
found = False
for line in lines:
    fields = line.split(":")
    if fields[0] == "hermes":
        fields[2] = uid
        fields[3] = gid
        fields[5] = "/opt/data"
        fields[6] = "/bin/sh"
        line = ":".join(fields)
        found = True
    updated.append(line)
if not found:
    updated.append(f"hermes:x:{uid}:{gid}::/opt/data:/bin/sh")
path.write_text("\n".join(updated) + "\n", encoding="utf-8")
PY

if [ "${HERMES_WORKBENCH_IDENTITY_ONLY:-0}" = "1" ]; then
  exit 0
fi

exec setpriv \
  --reuid="$runtime_uid" \
  --regid="$runtime_gid" \
  --clear-groups \
  python3 /opt/workbench/dashboard/sidecar_app.py
