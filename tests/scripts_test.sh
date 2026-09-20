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
import json, os, re, sys
m = json.load(open(sys.argv[1]))


def norm(path):
    # The installer records Git-Bash/MSYS-style paths (/c/Users/...) and
    # os.path may render its own Windows form (C:/Users/... with mixed
    # separators); fold both into one canonical shape on every platform:
    # forward slashes and a leading-slash drive aliased to <drive>:.
    p = path.replace("\\", "/")
    p = re.sub(r"^/([A-Za-z])/", lambda mm: mm.group(1).upper() + ":/", p)
    p = re.sub(r"^([A-Za-z]):/", lambda mm: mm.group(1).upper() + ":/", p)
    return p


base = norm(sys.argv[2])
owned = sorted(norm(p) for p in m["owned"])
expected = sorted(
    os.path.join(base, n).replace("\\", "/")
    for n in os.listdir(sys.argv[2]) if n.endswith(".ts"))
assert owned == expected, (
    sorted(m["owned"]),
    [os.path.join(sys.argv[2], n)
     for n in sorted(os.listdir(sys.argv[2])) if n.endswith(".ts")],
)
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

echo "== uninstall keeps telemetry by default =="
bash "$repo/scripts/install.sh" >/dev/null 2>&1 || fail "reinstall failed"
printf 'x\n' > "$scratch/home/.pi-cache/ledger.jsonl"
bash "$repo/scripts/uninstall.sh" >/dev/null 2>&1 || fail "uninstall exited nonzero"
[[ -f "$scratch/home/.pi-cache/ledger.jsonl" ]] || fail "ledger should be kept by default"
[[ ! -e "$dest" ]] || fail "extension dir still present"
echo "  ok: ledger kept, extension removed"

echo "== uninstall --purge =="
bash "$repo/scripts/install.sh" >/dev/null 2>&1 || fail "reinstall failed"
printf 'x\n' > "$scratch/home/.pi-cache/ledger.jsonl"
printf '{}\n' > "$scratch/home/.pi-cache/settings.json"
printf 'stale\n' > "$scratch/home/.pi-cache/ledger.jsonl.123.tmp"
mkdir -p "$scratch/home/.pi-cache/backups"
printf 'backup\n' > "$scratch/home/.pi-cache/backups/x.jsonl"
bash "$repo/scripts/uninstall.sh" --purge >/dev/null 2>&1 || fail "uninstall --purge exited nonzero"
[[ ! -e "$scratch/home/.pi-cache/ledger.jsonl" ]] || fail "ledger should be purged"
[[ ! -e "$scratch/home/.pi-cache/settings.json" ]] || fail "settings should be purged"
[[ ! -e "$scratch/home/.pi-cache/ledger.jsonl.123.tmp" ]] || fail "stale temp should be purged"
[[ ! -e "$scratch/home/.pi-cache/backups" ]] || fail "backups should be purged"
echo "  ok: telemetry and temp files purged"

echo "== uninstall leaves a tampered file in place =="
bash "$repo/scripts/install.sh" >/dev/null 2>&1 || fail "reinstall failed"
printf 'tampered\n' >> "$dest/index.ts"
bash "$repo/scripts/uninstall.sh" >/dev/null 2>&1 || fail "uninstall exited nonzero"
[[ -f "$dest/index.ts" ]] || fail "hash-mismatched file should survive"
[[ ! -e "$dest/affinity.ts" ]] || fail "untampered file should be removed"
echo "  ok: mismatched file preserved, others removed"

echo "scripts test: ok"
