#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="$project_root/dashboard/dist"

test -s "$dist/index.js"
test -s "$dist/style.css"
test -s "$dist/mermaid.min.js"

# The source build is the only canonical browser runtime. These checks keep
# accidental host-runtime copies and missing locale coverage out of releases.
if grep -Eq 'react\.production|react\.development|Symbol\.for\("react\.element"\)' "$dist/index.js"; then
  echo 'embedded React runtime detected' >&2
  exit 1
fi
grep -Eq 'hermes\.workbench\.zh-dashboard' "$dist/index.js"
# Vite minifiers may emit double quotes, single quotes, or template literals.
# Match the translation content without depending on the chosen quote style.
quote="['\"\`]"
for translation in 'Achievements:成就' 'kanban:看板'; do
  key="${translation%%:*}"
  value="${translation#*:}"
  if ! grep -Eq "${key}:[[:space:]]*(${quote})${value}\\1" "$dist/index.js"; then
    printf 'missing required release translation: %s → %s\n' "$key" "$value" >&2
    exit 1
  fi
done

printf 'Workbench release verified: %s\n' "$dist"
