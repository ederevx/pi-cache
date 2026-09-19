#!/usr/bin/env bash
# Uninstall pi-cache: remove the manifest-owned extension files and the
# manifest itself, then drop now-empty directories. Never touches
# unrelated files. Runtime telemetry (~/.pi/agent/.pi-cache/ledger.jsonl)
# is data, not an installed file, and is left in place.
set -euo pipefail

pi_home="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
manifest="$pi_home/.pi-cache/manifest.json"

if [[ ! -f "$manifest" ]]; then
  echo "uninstall: no manifest at $manifest — nothing installed by this repo" >&2
  exit 1
fi

mapfile -t owned < <(python3 - "$manifest" <<'EOF'
import json, sys
for path in json.load(open(sys.argv[1]))["owned"]:
    print(path)
EOF
)

for path in "${owned[@]}"; do
  if [[ -f "$path" || -L "$path" ]]; then
    rm -f "$path"
    echo "uninstall: removed $path"
  else
    echo "uninstall: missing (skipped) $path"
  fi
  # Drop the directory when this uninstall emptied it.
  dir="$(dirname "$path")"
  rmdir "$dir" 2>/dev/null || true
done

rm -f "$manifest"
rmdir "$pi_home/.pi-cache" 2>/dev/null || true
echo "uninstall: ok"
echo "  (telemetry ledger $pi_home/.pi-cache/ledger.jsonl was left in place)"