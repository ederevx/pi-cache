# Changelog

All notable changes to pi-cache are documented here. Each section maps to a
git tag, and the `version` in `package.json` matches the newest tag.

## [0.18.1] - 2026-10-31

### Fixed

- The shared cache key is derived only for chat-completions bodies. pi-ai also
  sets `prompt_cache_key` on long-tier compatible completions endpoints and on
  every openai-responses target, whose head lives in `input`/`instructions`
  rather than `messages`; there the key hashed model and tools alone, so
  unrelated sessions merged into one bucket, and on Codex it disagreed with the
  session id that drives the websocket request id. Those bodies now keep pi's
  per-session key.

### Changed

- The shared-key setting and README state that the rewrite covers
  chat-completions bodies and that one key carrying more than roughly 15
  requests a minute needs partitioning, which a per-session key already
  provides. The switch still ships off, and enabling it still waits on a
  long-tier measurement of first-request cache gains.

## [0.18.0] - 2026-10-31

### Added

- A calibration harness under `bench/calibration` measures where quality
  actually falls away instead of assuming it: paired fixture runs at five
  context lengths on both a full-history leg and a compaction leg, an exact
  binomial interval on each paired contrast, a familywise split over the nine
  contrasts with no interim look, and a classifier that answers `safe`,
  `harmful`, `trigger` or `inconclusive`. A grade is void when the fixture's
  test file moved before the run or was changed by the answer during it, and
  an empty completion is recorded `unusable` rather than counted as a wrong
  answer. Each run writes a profile fingerprint (grading version, lengths,
  alpha, margins, estimator, request limits, seed, repeats) and a store that
  `recompute` can re-derive under current rules.

### Changed

- The degradation onset constants remain policy defaults. The harness
  records what the pilot showed and what it did not: four fixtures and
  independent draws from them cannot establish an onset, and about a hundred
  independent tasks would be needed.

## [0.17.0] - 2026-10-30

### Changed

- Context degradation caps each onset point at an absolute token budget
  (`pressureDegradeStartTokens`/`pressureDegradeFullTokens`, defaults
  100 000/200 000; `<=0` leaves a point uncapped), so a large advertised
  window no longer postpones quality pressure far past the context a model
  holds up on. With the default fractional thresholds and token budgets,
  a window at or below 200 000 tokens keeps its previous curve. The
  budgets are policy defaults, not a measured universal limit, and they
  apply to paid models too.
- The midterm compaction gate fires once the live count passes that onset as
  well as at a share of the window, now `PI_CACHE_MIDTERM_MIN_PERCENT`
  (default 50). Probability saturation, the minimum-context floor, the
  cooldown, and the warm-cache floor are unchanged.

## [0.16.1] - 2026-10-29

### Fixed

- A `/cache-settings` dock that failed to open no longer answers like a session
  with no TUI: the failure reports its reason above the listing, and a headless
  run keeps the stderr listing.
- A settings row whose submenu cannot be built is reported instead of thrown,
  so the exception no longer escapes into pi's input loop and ends the dock on
  the first keypress.

## [0.16.0] - 2026-10-29

### Changed

- The fast-compaction digest retains each turn's last non-empty assistant
  text, its first two distinct agent bash command snippets, and its first
  available error excerpt alongside user text and tool names. Additional
  distinct commands and qualifying failures are counted, including failures
  with no text. Empty optional fields are omitted.
- A tool result qualifies as a failure when pi flags it, or when an unflagged
  bash result contains failure text. Unflagged results from other tools are
  ignored, so reading source code that mentions "error" adds no error entry.
- Default user-text and user-run command snippets increase from 80 to 240
  characters. Assistant text keeps 160 characters; agent commands and error
  excerpts keep 100 each, with an ellipsis added when truncated. Block and
  accumulated-region retention budgets increase to 12000 and 24000
  characters; these are not strict rendered-output limits.

## [0.15.0] - 2026-10-29

### Changed

- The model-parameter pull is no longer pinned to one vendor endpoint or gated
  on a provider id. `PI_CACHE_MODEL_PARAMS_URL` sets the endpoint (empty
  disables it), and it applies by the model's own `baseUrl` origin, so a
  regional or proxied endpoint works by pointing the knob at it. Each snapshot
  records the endpoint that produced it and is discarded when the endpoint
  changes, so another service's prices are never applied.
- The provider cache-lifetime table moved out of code into
  `PI_CACHE_TTL_PROFILES` (`token,token=short[,long];...`, whole-table
  replacement; malformed keeps the default, empty disables it).
- The poll's freshness, retry, timeout, and catalog-size bounds became
  `PI_CACHE_MODEL_PARAMS_{MAX_AGE_MS,RETRY_MS,TIMEOUT_MS,MAX_MODELS}`, bounded
  so an out-of-range value falls back instead of disabling the poll.

Defaults are unchanged.

## [0.14.2] - 2026-10-16

### Fixed

- The DeepSeek cache-lifetime profile assumed a four-hour TTL. OpenRouter
  sticky routing expires after ten minutes of inactivity and a host ledger
  put cache-hit share at 0.92 in the 5-10 minute gap band and 0.23 in the
  1-4 hour band, so the idle and before-turn compaction triggers fired
  after the cache had gone cold. The profile now uses 30 minutes.
- Boolean `PI_CACHE_*` environment options accept `on`. They previously
  treated it as false, so `PI_CACHE_FAST_COMPACT=on` silently disabled
  fast compaction.

## [0.14.1] - 2026-10-15

### Fixed

- Recognize this checkout by path, not directory name, in the one-loader
  guard (`scripts/install.sh`) and the postinstall reconciler
  (`scripts/settings-reconciler.mjs`). Both matched a local `packages`
  entry only when its final path component was `pi-cache`, so a worktree
  or renamed clone was missed: a manual install added a second extension
  copy beside the pin, and the reconciler left both entries loading it.
  A local entry that resolves to this checkout is now caught whatever
  the directory is called; the git-pin and same-named-directory rules are
  unchanged.

## [0.14.0] - 2026-10-15

### Added

- `cache_compact`, a model-callable tool that lets the agent request a
  context compaction on its own (typically for a complete context
  switch). It reports a draw-free snapshot of the cache state (lifetime
  and session scopes, live pressure) and queues at most one request per
  run; the request runs at the next settled boundary (`agent_settled`),
  so the tool result is delivered and the live run is not aborted. It
  bypasses the automatic policy (enable switch, warm floor, minimum
  tokens, cooldown, and the probability draw) but still honors the
  in-flight/window gate, and duplicate calls coalesce. `pre_cache` now
  gates and catalogs it. The ledger, `/cache-stats`, and the tool
  previews are draw-free, so reading live state no longer consumes a
  probabilistic compaction draw (`CompactionPressure.preview`).

### Fixed

- Global `/cache-stats` counters no longer cap at
  `PI_CACHE_LEDGER_MAX_ROWS` (default 20000). The ledger still retains
  only the newest window of rows, but folds every evicted row into a
  baseline persisted inside the same JSONL file, so `global (all time)`
  counts every recorded request while the file stays bounded; the
  `session` scope remains the current session's window. The baseline is
  written atomically with the row window, so a crash cannot desync the
  two, and a row that cannot be committed (a contended lock) is reported
  and never counted instead of being written outside the lock.

## [0.13.3] - 2026-10-09

### Fixed

- Auto-compaction no longer stalls on a warm-cache session. The ledger's
  `warm` field was set on every turn recorded while the cache was warm
  and also used to mark a warm-refresh telemetry row; `lastTurnRow()`
  skipped both, so `lastRowId()` only advanced when the cache went cold.
  The compaction gate keys its window on `lastRowId()`, so a settled
  window was never released and pi-cache stopped firing for hours (a
  live session stalled at 813k tokens of a 1M window with the pressure
  model still reporting probability 1). Warm-refresh rows now carry a
  ledger-owned `kind`, the turn-scoped accessors skip only that, and a
  failed or refused compaction releases the gate claim instead of
  retiring the window.

## [0.13.2] - 2026-10-07

### Fixed

- Fast compaction now bounds the verbatim window it keeps
  (`src/kept-window.ts`). pi's own cut walks back to roughly
  `keepRecentTokens`, but one context-visible entry larger than that
  budget (a many-hundred-KB tool result) forced the cut to the turn
  boundary before it, so the oversized entry stayed in the window and
  the post-compaction request could still exceed the provider context;
  the overflow retry then kept it again. When the retained window
  exceeds `PI_CACHE_FAST_KEEP_RATIO` (default 4) times
  `keepRecentTokens`, the cut advances to the next safe boundary whose
  window fits, the additionally dropped messages join the digest span,
  and when even the tail is one oversized entry the summary is kept
  alone. The dropped bytes stay in the session file the transcript
  pointer names.

## [0.13.1] - 2026-10-04

### Fixed

- Auto-compaction no longer stalls on the session-turn half of its
  cooldown. It differenced pi's per-run `turnIndex`, which resets to 0 on
  every new prompt, so once a compaction recorded an index no later short
  run could advance past it and the cooldown never elapsed again for the
  rest of the session. `AutocompactController` now owns a monotonic
  session-turn counter.

### Changed

- The auto-compaction decision is centralized on one shared evaluation:
  `decide`, the midterm predicate, and the `/cache-stats` preview read the
  same draw-free sample, and only `decide` consumes the pressure draw. The
  before-turn trigger no longer pre-decides before the compaction request,
  removing a duplicate RNG draw.

## [0.13.0] - 2026-10-01

### Added

- `pre_cache` onboarding tool (`src/pre-cache.ts`): one call returns
  pi-cache's tool catalog, conventions, and feature summary. The first
  call of any pi-cache-owned tool in a session is gated until it runs,
  and tool output uses pi's native collapsed rendering.

## [0.12.0] - 2026-09-28

### Added

- Fresh OpenRouter model parameters (`src/model-params.ts`): the
  compaction economics now price prompt-cache rates from a live pull of
  OpenRouter's public model list for OpenRouter-routed models, converting
  USD-per-token pricing to per-million and selecting any request-wide
  override tier by live token count. One pull is attempted per session
  and again when the snapshot goes stale; the last-good snapshot persists
  under `.pi-cache/model-params.json` (via `src/params-store.ts`, override
  with `PI_CACHE_MODEL_PARAMS`) and is used only when OpenRouter is
  inaccessible. Non-OpenRouter providers keep pi's rates.
- Provider-aware cache lifetimes (`src/model-ttl.ts`): the coldness ramp,
  idle timer, and ledger warm flag now measure against the provider's
  documented lifetime for the model in use (Anthropic 5m/1h, OpenAI 30m,
  DeepSeek 4h, Gemini 5m, Kimi 5m/1h, GLM ~2m) before the static
  `PI_CACHE_TTL_SECONDS` fallback.

### Fixed

- The startup temp sweep now covers the model-parameters directory, so an
  interrupted OpenRouter pull cannot leave a stale atomic temp beside the
  last-good snapshot.
- An unconfirmed warm decision no longer counts as a cache touch: only a
  landed `cache_warm` refresh resets the age the coldness ramp and idle
  clock measure, so a refresh that never lands cannot delay compaction.
- The midterm gate is genuinely RNG-free: `CompactionPressure.probability()`
  composes the pressure without drawing, so `midtermEligible()` no longer
  perturbs the probabilistic decision it reads.
- The miss classifier uses each ledger row's recorded cache TTL, so the
  `/cache-stats` diagnosis shares the idle ramp's lifetime model instead
  of falling back to the static default.
- `RowExtrasBuilder` degrades field-by-field as documented; one failing
  signal no longer drops the fields that follow it.
- The `miss-classifier`, `row-extras`, and `warming-schedule` suites are
  now imported by the test runner; they were committed but never run.

### Changed

- The expected-cost horizon now accounts for the last cache touch: the
  current request always counts, and each further expected request counts
  only while the cache is still warm, so a prefix near TTL expiry is
  amortized over a shorter horizon than a freshly touched one.
- The compaction decision and the `/cache-stats` preview both read the
  freshest request of any kind (warm refreshes included) as the warmth
  measurement, so a just-landed refresh is reflected consistently.

## [0.11.0] - 2026-09-28

### Added

- Midterm compaction trigger at the `turn_end` boundary, behind
  `PI_CACHE_MIDTERM` (default on) with a `/cache-settings` row. It fires
  only when the compaction pressure is saturated (probability 1) and the
  window is at least half full, so a long agentic run compacts without
  waiting to settle; `AutocompactController.midtermEligible()` is the
  pure gate. The cut is planned with pi's exported `findCutPoint`
  (`src/midterm-cut.ts`), so it never lands on a tool result.

### Changed

- Midterm compaction no longer aborts the run. pi-cache returns pi's
  boundary compaction draft plus `continue: true`, so pi applies the
  compaction and resumes the run; the draft reuses the fast-compaction
  summary (`src/midterm.ts`), which keeps the mid-run rewrite
  cache-neutral. A turn with no tool results still commits the draft but
  asks for no continuation. Without fast compaction the point keeps the
  aborting `ctx.compact()` fallback, because pi does not export the
  split-turn summary helpers a non-fast draft would need.

## [0.10.4] - 2026-09-25

### Added

- "Restore default configuration" in `/cache-settings` (and a
  `restore`/`reset` argument): `UserSettingsStore.reset()` writes an
  empty document through the atomic path, preserving the file mode, and
  `SettingsSwitchBoard.restoreDefaults()` reapplies each route's
  built-in default live, so fast compaction keeps auto-compaction's
  cache-neutral relaxation in sync and `PI_CACHE_*` pins still win. The
  action opens a confirmation submenu.

### Fixed

- Pass `SettingsPresenter` rather than the stateless
  `CacheStatsPresenter` to the switch board, so the miss-diagnosis
  toggle has its owning presenter.

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