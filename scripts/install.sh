#!/usr/bin/env bash
# Install the pi-cache prompt-caching extension into the Pi agent home.
#
# Copies the src/ extension files into the auto-discovered extensions
# directory (~/.pi/agent/extensions/pi-cache, loaded via its index.ts),
# recording every owned file in a manifest so uninstall removes exactly
# what this repo installed. Idempotent: re-running refreshes owned
# copies in place; existing unrelated files are never touched.
#
# The runtime telemetry dir (~/.pi/agent/.pi-cache) is shared: the
# installer writes only manifest.json beside the ledger and never
# touches the ledger itself.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi_home="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
dest_dir="$pi_home/extensions/pi-cache"
state_dir="$pi_home/.pi-cache"
manifest="$state_dir/manifest.json"

[[ -d "$pi_home" ]] || {
  echo "install: missing Pi agent home: $pi_home" >&2
  exit 1
}
shopt -s nullglob
sources=("$repo_root"/src/*.ts)
[[ ${#sources[@]} -gt 0 ]] || {
  echo "install: no src/*.ts files found at $repo_root/src" >&2
  exit 1
}

# The one-loader guard: a pinned pi package already loads this repo's
# extension (src/index.ts) from its own clone, and a manual copy beside
# it aborts every new pi session with tool-conflict errors. The manual
# installer therefore refuses outright whenever a packages entry installs
# pi-cache - a git pin or a local path whose final component is this
# package. Uninstall the manual copy or drop the pin first; nothing on
# disk has been touched by the refusal.
settings="$pi_home/settings.json"
if [[ -f "$settings" ]]; then
  python_bin=""
  for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1; then python_bin="$candidate"; break; fi
  done
  if [[ -n "$python_bin" ]]; then
    pinned="$($python_bin - "$settings" <<'PYGUARD'
import json, sys
try:
    packages = json.load(open(sys.argv[1], encoding="utf-8")).get("packages", [])
except Exception:
    packages = []
for entry in packages:
    if not isinstance(entry, str):
        continue
    normalized = entry.replace("\\", "/").rstrip("/")
    if (normalized.startswith("git:") and "pi-cache" in normalized)             or normalized.rsplit("/", 1)[-1] == "pi-cache":
        print(entry)
        break
PYGUARD
)"
    if [[ -n "$pinned" ]]; then
      echo "install: pi-cache is installed as a pi package ($pinned)." >&2
      echo "  A manual install would load its extension twice and abort every" >&2
      echo "  new session with tool-conflict errors. Update the package instead:" >&2
      echo "  pi update git:github.com/ederevx/pi-cache  (or drop the pin before" >&2
      echo "  a manual install; scripts/uninstall.sh removes a manual copy)." >&2
      exit 1
    fi
  fi
fi

mkdir -p "$dest_dir" "$state_dir"

# Drop stale atomic-write temp files from an interrupted prior install.
find "$dest_dir" "$state_dir" -maxdepth 1 -name '*.tmp*' -type f -exec rm -f {} + 2>/dev/null || true

install_to() {
  # Atomic replacement, per shared convention: never truncate a file
  # that running software may read or execute — land the complete new
  # content via a same-directory temp file and rename it over.
  local mode="$1" src="$2" dest="$3" tmp="$3.tmp.$$"
  install -m "$mode" "$src" "$tmp"
  mv -f "$tmp" "$dest"
}

owned=()
for src in "${sources[@]}"; do
  install_to 644 "$src" "$dest_dir/$(basename "$src")"
  owned+=("$dest_dir/$(basename "$src")")
done

{
  printf '{\n'
  printf '  "version": 1,\n'
  printf '  "repo": "%s",\n' "$repo_root"
  printf '  "owned": [\n'
  for i in "${!owned[@]}"; do
    printf '    "%s"%s\n' "${owned[$i]}" "$([[ $i -lt $((${#owned[@]} - 1)) ]] && printf ,)"
  done
  printf '  ],\n'
  printf '  "hashes": {\n'
  for i in "${!owned[@]}"; do
    printf '    "%s": "%s"%s\n' "${owned[$i]}" "$(sha256sum "${owned[$i]}" | cut -d' ' -f1)" \
      "$([[ $i -lt $((${#owned[@]} - 1)) ]] && printf ,)"
  done
  printf '  }\n}\n'
} > "$manifest.tmp"
mv "$manifest.tmp" "$manifest"

echo "install: ok"
echo "  extension: $dest_dir (${#owned[@]} files)"
echo "  manifest:  $manifest"
echo
echo "Restart pi or run /reload to load the extension (pi's reload"
echo "watch may already have typed /reload for it)."