# Changelog

All notable changes to pi-cache are documented here. Each section maps to a
git tag, and the `version` in `package.json` matches the newest tag.

## [Unreleased]

### Changed

- Rebuild compaction pressure around expected cost instead of context-window
  occupancy. `CompactionPressure` now blends an expected-cost economics model
  (write amortization, coldness, expected remaining requests) with a
  context-degradation onset, combined by inclusion-exclusion; occupancy
  cancels out of the cost ratio, so a warm low-horizon prefix no longer
  pressures merely for being large. Costs come from `ctx.model.cost`.
- Replace the `PI_CACHE_PRESSURE_START`/`_FULL`/`_CACHE_DISCOUNT`/
  `_COLD_PREMIUM` tunables with `_CONTINUATION`, `_MAX_REQUESTS`,
  `_KEEP_FRACTION`, `_SUMMARY_COST`, `_DEGRADE_START`, `_DEGRADE_FULL`, and
  `_DEGRADE_GAMMA`.

## [0.1.3] - 2026-09-20

### Fixed

- Emit LF-only lookup records from the uninstall manifest helper; on
  Windows, Python's text stdout translated each newline to CRLF, which
  made every hash comparison fail and left every owned file in place.
- Make the installer round-trip and the default-path assertions in the
  test suite platform-independent, covering Windows backslash
  separators and MSYS-style `/c/...` roots.

[0.1.3]: https://github.com/ederevx/pi-cache/releases/tag/v0.1.3

## [0.1.2] - 2026-09-20

### Changed

- Add `.npmrc` with `package-lock=false`. pi runs `npm install` in a git
  clone, which otherwise writes an untracked `package-lock.json`; the
  package has no runtime dependencies to lock.

[0.1.2]: https://github.com/ederevx/pi-cache/releases/tag/v0.1.2

## [0.1.1] - 2026-09-20

### Fixed

- Mark the bundled pi core packages optional in `peerDependenciesMeta`. pi
  installs a git package with `npm install --omit=dev`, which auto-installs
  the root package's peer dependencies; without this, npm vendored
  `@earendil-works/pi-ai` and `pi-coding-agent` and their transitive tree
  (about 229 packages, 516 MB) into the clone even though the extension
  resolves them through pi's loader aliases.

[0.1.1]: https://github.com/ederevx/pi-cache/releases/tag/v0.1.1

## [0.1.0] - 2026-09-20

Initial public release. pi-cache is a pi extension declared in `package.json`
(`pi.extensions` -> `./src/index.ts`) with no build step and no third-party
runtime dependency; the pi core packages are `peerDependencies`.

### Added

- Cache telemetry from `message_end` (`usage.cacheRead` / `cacheWrite` and
  cost) into a bounded JSONL ledger with retention, pre-trim backups and
  backup GC, plus `/cache-stats` with global and session scopes.
- Stable prefix normalization, tool-schema hygiene (deterministic ordering,
  dedup, volatile-field removal), and session-affinity guardrails.
- Cache-aware auto-compaction: a token-driven probabilistic compaction
  pressure graded by cache coldness, and a fast-compaction override that
  answers every compaction reason (`manual` / `threshold` / `overflow`) and
  wanted `/tree` branch summaries with a byte-stable cache-preserving
  replacement.
- `/cache-settings` switch and `PI_CACHE_*` environment controls.
- Manifest-owned `scripts/install.sh` and `scripts/uninstall.sh`.
- Design, implementation-reference, and research documents under `docs/`.

### Changed

- All cache-favoring features default to on.
- Auto-compaction is owned by the token/coldness pressure; `/tree` branch
  summaries gained an independent `PI_CACHE_FAST_BRANCH_SUMMARY` switch.

### Fixed

- Emit `/cache-stats` through `ctx.ui.notify`.
- Use the string-option selector in `/cache-settings`.
- Keep `cache_control` when sorting tool definitions.
- Neutralize the warm-cache discount under fast compaction so a fully cached
  context still reaches the compaction ramp.

### Removed

- The soft per-turn compaction experiments, superseded by fast compaction.

[0.1.0]: https://github.com/ederevx/pi-cache/releases/tag/v0.1.0