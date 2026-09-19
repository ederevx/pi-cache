#!/usr/bin/env bash
# pi-cache installer round-trip test: install into a throwaway
# PI_CODING_AGENT_DIR, verify parity and the manifest, uninstall, and
# assert nothing is left behind. Scratch lives under ~/tmp (never /tmp).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "$HOME/tmp/pi-cache-scripts-test-XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
export PI_CODING_AGENT_DIR="$scratch/home"
mkdir -p "$scratch/home"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== install =="
bash "$repo/scripts/install.sh" || fail "install exited nonzero"
dest="$scratch/home/extensions/pi-cache"
manifest="$scratch/home/.pi-cache/manifest.json"
[[ -f "$dest/index.ts" ]] || fail "index.ts not installed"
[[ -f "$manifest" ]] || fail "manifest not written"

src_count=$(find "$repo/src" -maxdepth 1 -name '*.ts' | wc -l)
dest_count=$(find "$dest" -maxdepth 1 -name '*.ts' | wc -l)
[[ "$src_count" -eq "$dest_count" ]] || fail "file count differs: src=$src_count dest=$dest_count"

for src_ts in "$repo"/src/*.ts; do
  base=$(basename "$src_ts")
  a=$(sha256sum "$src_ts" | cut -d' ' -f1)
  b=$(sha256sum "$dest/$base" | cut -d' ' -f1)
  [[ "$a" == "$b" ]] || fail "sha mismatch for $base"
done
echo "  ok: $dest_count files, sha parity, manifest present"

# the manifest is readable JSON and lists the same set
python3 - "$manifest" "$dest" <<'EOF' || fail "manifest validation"
import json, os, sys
m = json.load(open(sys.argv[1]))
expected = sorted(
    os.path.join(sys.argv[2], n) for n in os.listdir(sys.argv[2])
    if n.endswith(".ts"))
assert sorted(m["owned"]) == expected, (sorted(m["owned"]), expected)
assert set(m["hashes"]) == set(m["owned"])
EOF
echo "  ok: manifest owns exactly the installed files"

# reinstall is idempotent
bash "$repo/scripts/install.sh" >/dev/null 2>&1 || fail "reinstall failed"
for src_ts in "$repo"/src/*.ts; do
  a=$(sha256sum "$src_ts" | cut -d' ' -f1)
  b=$(sha256sum "$dest/$(basename "$src_ts")" | cut -d' ' -f1)
  [[ "$a" == "$b" ]] || fail "reinstall broke $src_ts"
done
echo "  ok: reinstall idempotent"

echo "== uninstall =="
bash "$repo/scripts/uninstall.sh" >/dev/null 2>&1 || fail "uninstall exited nonzero"
[[ ! -e "$dest" ]] || fail "extension dir still present"
[[ ! -e "$manifest" ]] || fail "manifest still present"
echo "  ok: everything owned is gone"

echo "scripts test: ok"