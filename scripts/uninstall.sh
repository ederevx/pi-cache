#!/usr/bin/env bash
# Uninstall pi-cache: remove the manifest-owned extension files whose
# recorded hashes still match, then the manifest itself, then drop
# now-empty directories. With --purge, also remove the runtime telemetry
# (ledger + settings) and stale temp files. Never touches unrelated files.
set -euo pipefail

purge=false
for arg in "$@"; do
  case "$arg" in
    --purge) purge=true ;;
    *) echo "uninstall: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

pi_home="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
state_dir="$pi_home/.pi-cache"
manifest="$state_dir/manifest.json"

if [[ ! -f "$manifest" ]]; then
  echo "uninstall: no manifest at $manifest — nothing installed by this repo" >&2
  exit 1
fi

# Emit "path<TAB>sha256" for every owned file, LF-only: Windows text
# stdout translates "\n" to "\r\n", which would trail every value with
# a CR that bash mapfile keeps and every hash comparison then fails on.
mapfile -t owned < <(python3 - "$manifest" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
hashes = m.get("hashes", {})
out = sys.stdout.buffer
for path in m.get("owned", []):
    out.write(f"{path}\t{hashes.get(path, '')}\n".encode())
EOF
)

for entry in "${owned[@]}"; do
  path="${entry%%$'\t'*}"
  want="${entry#*$'\t'}"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    echo "uninstall: missing (skipped) $path"
    continue
  fi
  got="$(sha256sum "$path" 2>/dev/null | cut -d' ' -f1 || true)"
  if [[ -n "$want" && "$got" != "$want" ]]; then
    echo "uninstall: WARNING hash mismatch, left in place: $path" >&2
    continue
  fi
  rm -f "$path"
  echo "uninstall: removed $path"
  # Drop the directory when this uninstall emptied it.
  dir="$(dirname "$path")"
  rmdir "$dir" 2>/dev/null || true
done

rm -f "$manifest"

if $purge; then
  for name in ledger.jsonl settings.json; do
    if [[ -f "$state_dir/$name" ]]; then
      rm -f "$state_dir/$name"
      echo "uninstall: purged $state_dir/$name"
    fi
  done
  find "$state_dir" -maxdepth 1 -name '*.tmp*' -type f -exec rm -f {} + 2>/dev/null || true
  if [[ -d "$state_dir/backups" ]]; then
    rm -rf "$state_dir/backups"
    echo "uninstall: purged $state_dir/backups"
  fi
fi

rmdir "$state_dir" 2>/dev/null || true

echo "uninstall: ok"
if ! $purge && [[ -f "$state_dir/ledger.jsonl" ]]; then
  echo "  (telemetry $state_dir/ledger.jsonl left in place; rerun with --purge to remove)"
fi
