# Changelog

All notable changes to pi-cache are documented here. Each section maps to a
git tag, and the `version` in `package.json` matches the newest tag.

## [0.10.2] - 2026-09-23

### Changed

- File-op hardening and dedupe (PR #16, no behavior change): new
  `src/atomic-file.ts` is the single owner of the temp+rename+cleanup
  +mode-preserve contract (fixes user-settings forcing mode 0o600 and
  its leftover-temp error path); `sink.ts` collapses its triplicated
  lock+dir+append logic into one `underLock` owner and cleans temps on
  failed writes; `backup-store.ts` prune() does one greedy
  ring/TTL/size pass over a single listing; new `src/prefix-head.ts`
  owns the cache-relevant head fingerprint shared by normalizer and
  cache-key. Net lines 167+/167-.

## [0.10.1] - 2026-09-23

### Added

- Package-only install guard, both directions: npm postinstall runs the
  settings reconciler plus `ManualCopyCleaner`; the manual installer
  refuses when a settings packages entry installs pi-cache.

## [0.10.0] - 2026-09-23

### Added

- Dropped-span digest for fast compaction (`src/digest.ts`, behind the
  new `fastDigest` /cache-settings switch, `PI_CACHE_FAST_DIGEST`
  env var, default on): a bounded deterministic extractive record of
  the summarized span (files from pi's `fileOps`, one capped line per
  turn) appended after the stub, folding the previous compaction's
  digest blocks in so the record accumulates across repeated
  compactions instead of the prior summary vanishing inside the next
  dropped span. Position is cache-neutral (after the stub text); spans
  above `PI_CACHE_FAST_DIGEST_MAX_SPAN_TOKENS` (default 24000) fall
  back to pi's LLM summarizer; digest failure degrades to the bare
  stub.

## [0.8.0] - 2026-09-22

### Removed

- Observation-only telemetry that never changed a wire byte: the
  header AffinityObserver (pi 0.87 providers key affinity on content,
  so the observed headers were inert), the MissClassifier diagnosis
  and its /cache-stats miss line and compaction advisory, and the
  ProviderTtlResolver/TtlLearner pair (the learned knee never beat the
  documented per-provider profile; the static PI_CACHE_TTL_SECONDS
  fallback stands). The affinity-rotation autocompact signal goes with
  the observer; head-churn keeps the churn-to-cold path.
- The tools sort transform and PI_CACHE_SORT_TOOLS: pi builds the
  tools array in a fixed per-session order, so sorting only
  re-canonicalized away from pi's own order and moved the pinned
  cache_control marker. Tool dedup stays, with the trailing-marker
  re-pin.

# Changelog

All notable changes to pi-cache are documented here. Each section maps to a
git tag, and the `version` in `package.json` matches the newest tag.

## [0.7.0] - 2026-09-22

### Added

- Request-transform pipeline extensions (all hook-implementable, each
  with a `/cache-settings` switch and a `PI_CACHE_*` env override): a
  mid-history Anthropic breakpoint anchor (`PI_CACHE_ANCHOR`, default
  on) that spends the fourth `cache_control` slot on a quantum-aligned
  stable position behind pi's trailing marker; a per-request long
  retention rewrite (`PI_CACHE_RETENTION_OVERRIDE`, default off) that
  upgrades every marker to the 1h tier and OpenAI payloads carrying a
  prompt_cache_key to 24h; system-listing canonicalization
  (`PI_CACHE_CANONICALIZE`, default on) sorting skill and AGENTS.md
  entries code-unit order for cross-spawn prefix stability; a shared
  OpenAI `prompt_cache_key` derived from the prefix head
  (`PI_CACHE_SHARED_KEY`, opt-in); and a forced-warm policy for pi's
  cache-warming decision (`PI_CACHE_FORCE_WARM`, opt-in).
- `/cache-settings` rows pinned by a set `PI_CACHE_*` env var are marked
  env-pinned and refuse toggles (env beats stored settings on every
  restart, so a losing toggle lied before).
- The TTL signals follow the effective per-request retention tier
  instead of the static env mirror.

### Changed

- `PI_CACHE_SORT_TOOLS` now defaults off: pi 0.87 already serializes
  tools in a fixed per-session order, so sorting only re-canonicalizes
  away from pi's own order.

### Removed

- `PI_CACHE_PIN_SESSION` / `SessionPinner`: pi 0.87 providers key
  affinity on content (prompt_cache_key, or sticky-routing headers
  pi-ai already sends), so header injection was inert. Cross-spawn
  bucket sharing is the shared cache key's job now.

## [0.5.1] - 2026-09-21

### Fixed

- Validate the parsed settings object shape before trusting it, sweep
  stray temps in the settings directory, and remove the local
  shadowing of the pressure model.

## [0.5.0] - 2026-09-21

### Fixed

- Make every `/cache-settings` row editable. The six option rows (telemetry,
  sort tools, dedup tools, session pin, compaction advisory, auto-compaction)
  now cycle on/off and persist like the two fast-compaction switches, instead
  of silently ignoring Enter/Space while the list hint promised a change. Each
  option applies to its live owning controller, the idle and before-turn
  triggers read the auto-compaction switch through a predicate, and the owned
  settings file now backs all eight options below `PI_CACHE_*` env precedence.

[0.5.0]: https://github.com/ederevx/pi-cache/releases/tag/v0.5.0

[0.7.0]: https://github.com/ederevx/pi-cache/compare/v0.6.0...v0.7.0

## [0.4.0] - 2026-09-21

### Added

- Confirm landed cache-warm refreshes from the persisted `cache_warm` usage
  entries: `WarmingObserver.reconcile` scans the session tail newest-first
  (across branches, deduped by entry id) at session start, turn end, input,
  the warm decision, and agent settle, and the measured cache age is the
  most recent of the decision intent and the confirmation.
- Render `/cache-settings` in pi's two-column settings layout (padded label
  | current value, selected-row description and key hint, search and mouse
  support) using pi-tui's `SettingsList`; the two live fast-compaction
  switches cycle in place and persist, while the env-resolved options stay
  display-only.

[0.4.0]: https://github.com/ederevx/pi-cache/releases/tag/v0.4.0

## [0.3.0] - 2026-09-21

### Added

- Trigger auto-compaction before a turn and while idle, not only after a
  turn settles. A cold prompt now defers until compaction finishes before
  pi builds the turn, and a session-scoped TTL timer compacts when the
  provider cache expires while pi is idle. New switches
  `PI_CACHE_IDLE_TRIGGER` and `PI_CACHE_BEFORE_TURN` (both default on).
- `CompactionGate` limits auto-compaction to one per idle window and never
  two in flight; `WarmingObserver` measures cache age from the last turn
  or a pi warm refresh so the idle timer does not compact a cache pi just
  kept alive.

### Changed

- The coldness idle ramp now measures from the last cache touch (last turn
  or warm refresh) instead of only the last turn.

[0.3.0]: https://github.com/ederevx/pi-cache/releases/tag/v0.3.0

## [0.2.1] - 2026-09-20

### Fixed

- Floor the expected-cost compaction pressure on a minimum live context
  (`PI_CACHE_PRESSURE_MIN_TOKENS`, default 50000). Because the economics
  term is flat in token count it fired on a trivial cold context, pi
  refused to compact, and the unguarded async `ctx.compact` onError
  callback then appended to a stale extension ctx and exited pi with
  status 1.
- Fail-open the async auto-compaction `onError` callback like every other
  hook, so a refused or failed compaction can never break the process.
- Bound the ledger file during a long session, not only on load and
  shutdown, and sweep abandoned atomic-write temps during a backup prune.
- Match only the exact `.tmp` suffix when sweeping temps, so an unrelated
  file that merely contains `.tmp` is never deleted.
- Give ledger backups a pid-qualified atomic name so sibling processes
  cannot collide or leave a partial file counted as a backup.

### Changed

- Move the live signal readers (model cost rates, cache TTL, session id,
  autocompact signals) into a `SessionSignals` class, and split the
  multi-purpose normalizer, autocompaction, backup, and settings methods
  into single-purpose helpers. No behavior change.

[0.2.1]: https://github.com/ederevx/pi-cache/releases/tag/v0.2.1

## [0.2.0] - 2026-09-20

### Changed

- Rebuild compaction pressure around expected cost instead of context-window
  occupancy. `CompactionPressure` now blends an expected-cost economics model
  (write amortization, coldness, expected remaining requests) with a
  context-degradation onset, combined by inclusion-exclusion. Occupancy
  cancels out of the cost ratio, so a warm low-horizon prefix no longer
  pressures merely for being large; it still rises with occupancy through
  the degradation onset. Costs come from `ctx.model.cost`.
- Replace the `PI_CACHE_PRESSURE_START`/`_FULL`/`_CACHE_DISCOUNT`/
  `_COLD_PREMIUM` tunables with `_CONTINUATION`, `_MAX_REQUESTS`,
  `_KEEP_FRACTION`, `_SUMMARY_COST`, `_DEGRADE_START`, `_DEGRADE_FULL`, and
  `_DEGRADE_GAMMA`.

[0.2.0]: https://github.com/ederevx/pi-cache/releases/tag/v0.2.0

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