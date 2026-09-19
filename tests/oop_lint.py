#!/usr/bin/env python3
"""Static OOP + extension-format + feature-removal enforcement for
pi-cache.

House rule (shared memory): owned program logic is structured as
classes with single-responsibility methods; state is mutated only by
its owning object or explicitly through an input parameter - never
through module globals or another function's side effects. Extension
formatting follows https://pi.dev/docs/latest/extensions: a single
default-export module per entry, TypeScript only.

Checks:
  1. src/*.ts: no top-level mutable bindings (`let`/`var`, or `const`
     containers such as Map/Set/object/array at module scope). Classes
     may own mutable instance fields.
  2. Extension formatting: the entry module (src/index.ts) declares a
     default export, and src/ contains only .ts files (no .mjs or
     stray artifacts).
  3. Soft-compaction removal completeness: the removed feature's
     identifiers must not reappear in src/.
"""

import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILURES: list[str] = []


def fail(path: str, message: str) -> None:
    FAILURES.append(f"{path}: {message}")


TS_TOP_LEVEL_BAD = [
    (r"^\s*let\s+", "top-level let binding"),
    (r"^\s*var\s+", "top-level var binding"),
]

TS_CONST_CONTAINER = re.compile(
    r"^\s*const\s+\w+\s*=\s*(new\s+(Map|Set)\b|\{|\[)"
)


def check_typescript(path: str) -> None:
    """Walk statements tracking brace depth; flag module-scope bindings
    that introduce mutable state. Instance fields and class-local state
    are allowed (owned by the object)."""
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    depth = 0
    for lineno, raw in enumerate(lines, 1):
        line = raw.rstrip("\n")
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("/*") \
                or stripped.startswith("*"):
            continue
        depth += line.count("{") - line.count("}")
        if depth != 0 or not stripped:
            continue
        for pattern, label in TS_TOP_LEVEL_BAD:
            if re.match(pattern, stripped):
                fail(path, f"line {lineno}: {label}: {stripped[:60]}")
        if TS_CONST_CONTAINER.match(stripped):
            fail(path, f"line {lineno}: top-level mutable const container: {stripped[:60]}")


REMOVED_SOFT_IDENTS = [
    r"softcompact",
    r"compactstore",
    r"FAST_COMPACTION_STUB",
    r"softCompactMode",
    r"softCompactMinDeltaTurns",
    r"softMinTokens",
    r"PI_CACHE_SOFT_COMPACT",
    r"PI_CACHE_SOFT_MIN_TOKENS",
    r"PI_CACHE_ONCE_MIN_TOKENS",
    r"PI_CACHE_COMPACT_DIR",
    r"compactRing",
    r"compactTtlDays",
    r"compactMaxArtifacts",
    r"compactMaxMb",
    r"compactCapture",
]

REMOVED_PATTERNS = [re.compile(p) for p in REMOVED_SOFT_IDENTS]


def check_no_soft_residue(src_dir: str) -> None:
    for name in sorted(os.listdir(src_dir)):
        if not name.endswith(".ts"):
            continue
        path = os.path.join(src_dir, name)
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        for pattern in REMOVED_PATTERNS:
            m = pattern.search(text)
            if m:
                fail(path, f"removed-feature identifier: {m.group(0)!r}")


def check_extension_format(src_dir: str) -> None:
    """Per pi.dev/docs/latest/extensions: a .ts-only source tree whose
    directory-style extension entry (index.ts) exports default."""
    for name in sorted(os.listdir(src_dir)):
        if name == ".DS_Store":
            continue
        if not name.endswith(".ts"):
            fail(os.path.join(src_dir, name), "non-TS file in the extension source")
    index = os.path.join(src_dir, "index.ts")
    if not os.path.isfile(index):
        fail(index, "missing directory-style entry index.ts")
        return
    with open(index, "r", encoding="utf-8") as f:
        if not re.search(r"\bexport\s+default\b", f.read()):
            fail(index, "entry module must declare a default export")


def main() -> int:
    src_dir = os.path.join(REPO, "src")
    for name in sorted(os.listdir(src_dir)):
        if name.endswith(".ts"):
            check_typescript(os.path.join(src_dir, name))
    check_extension_format(src_dir)
    check_no_soft_residue(src_dir)
    if FAILURES:
        for item in FAILURES:
            print("OOP-LINT FAIL: " + item)
        return 1
    print("oop lint: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())