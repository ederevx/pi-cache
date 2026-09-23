# pi-cache

A pi coding-agent extension that maximizes LLM prompt-cache hit rate and
cuts token cost. Public research + implementation repo.

## Status

Design, research, and implementation are complete: house-structured OOP
code, validated by the zero-dependency suite under `tests/` (see
`tests/run.ts`), and installed in the pi runtime. Paired A/B validation
is the remaining step.

## How it works

Cache-aware compaction has two layers, both on by default.

- **Compaction pressure.** The auto-compaction trigger is a
  probabilistic *compaction pressure* that blends context degradation as
  the window fills with the expected cost of continuing versus rewriting
  the prefix (cache write amortization, coldness, TTL idle ramp), with a
  warm-cache floor and fast compaction relaxing it. It fires at three
  idle points when the pressure draw passes: after a turn settles
  (`agent_settled`), on a session-scoped timer when the provider cache
  TTL expires while pi sits idle (`PI_CACHE_IDLE_TRIGGER`), and when a
  cold prompt arrives before a turn (the `input` handler defers the
  prompt until compaction finishes, `PI_CACHE_BEFORE_TURN`). With fast
  compaction on, the cache-window gate is relaxed because the override
  is prefix-stable; with it off, compaction stays inside cold/churned
  windows.
- **Fast compaction override.** When fast compaction is on, pi-cache
  answers `session_before_compact` for *every* compaction reason
  (`manual`/`threshold`/`overflow`) with a byte-stable cache-aware
  override that replaces pi's LLM summarizer entirely, and answers a
  wanted `/tree` branch summary (`session_before_tree`) the same way.
  Turn it off with the `/cache-settings` switch or
  `PI_CACHE_FAST_COMPACT=off`; branch summaries have their own
  `PI_CACHE_FAST_BRANCH_SUMMARY` switch, and pi's own normal summarizer
  runs for whichever is off.
- **Dropped-span digest.** The fast stub alone discards the summarized
  span's content; with the digest on (default), pi-cache appends a
  deterministic, bounded extractive record after the stub — modified
  and read files (from pi's own `fileOps`), one capped line per turn
  (first user text, bash commands, tool names) — and folds the previous
  compaction's digest blocks in, so the record accumulates across
  repeated compactions instead of vanishing. The digest sits after the
  stub text, so the shared prefix head is byte-identical either way.
  Fast compaction is enforced for dropped spans of any size — no span
  ever falls back to pi's slow LLM summarizer. After the digest (or
  alone when it is empty) the summary carries a deterministic
  transcript pointer naming the session file and the boundary entry id,
  so dropped detail stays recallable on demand with a bounded search
  (`grep -m 5 '<term>' <session-file>`) instead of a whole-file read.
  Disable the digest with the `/cache-settings` switch or
  `PI_CACHE_FAST_DIGEST=off`.

The cache TTL that drives the idle trigger and the compaction-pressure
ramp falls back to `PI_CACHE_TTL_SECONDS` (default 300 s) when the model
declares no `promptCache` tier.

## Request transforms

Cache-favoring request transforms are ON by default; the per-request
long-retention override, shared OpenAI cache key, and forced warming are
opt-in. Disable any feature with its `PI_CACHE_*` env var (see
`src/constants.ts`) or with the `/cache-settings` switch (which
persists to pi-cache's owned
`~/.pi/agent/.pi-cache/settings.json`; a set env var pins its row).

- **Tool dedup** — exact-schema tool dedup; volatile fields (cwd,
  absolute paths) removed from tool definitions.
- **Breakpoint anchor** — a fourth Anthropic `cache_control` marker
  pinned on stable mid-history at a quantum position (bounds tail-churn
  loss and the >20-block walk-back gap).
- **Canonicalization** — skill/project listings in the system prompt
  canonicalized so stable regions stay byte-stable.
- **Retention override** — per-request rewrite upgrading every marker to
  the 1h tier (`PI_CACHE_RETENTION_OVERRIDE`).
- **Shared key** — the OpenAI `prompt_cache_key` derived from the prefix
  head so sibling sessions share a warm bucket (`PI_CACHE_SHARED_KEY`).
- **Force warm** — pi's warming decision kept warm when its own
  economics justify it and a real turn exists (`PI_CACHE_FORCE_WARM`);
  the warming schedule follows the tier the rewrite actually put on the
  wire, idle fires defer past an in-flight refresh, and confirmed
  refreshes land in the ledger as `warm`-flagged rows.

## Telemetry

Telemetry goes to the `.pi-cache/ledger.jsonl` dot-dir and survives
reloads. Each usage row also carries the request's cache state as
optional fields (`cacheTtlMs`, `piTtlMs`, `retentionLong`, `warm`,
`msSinceCacheTouch`) so tier and warm-vs-miss questions are answerable
from the ledger itself; rows written without them stay
schema-compatible.

The ledger keeps the most recent `PI_CACHE_LEDGER_MAX_ROWS` rows
(default 20000; trimmed on load, in-session once a full window of
appends accumulates, and at session shutdown). A bounded pre-trim backup
is captured before any shrinking rewrite
(`PI_CACHE_LEDGER_BACKUPS`/`_TTL_DAYS`/`_MAX_MB`). Session stats are
rebuilt from the ledger on session start so they survive reloads, and
stale atomic-write temp files are swept at load.

Live views: `/cache-stats` (global and session scopes, with live
compaction pressure) and `/cache-settings`.

## Installation

As a pi package (see `docs/packages.md`):

    pi install /absolute/path/to/pi-cache
    pi -e /absolute/path/to/pi-cache      # try it for one run

The repo declares its extension in `package.json` under the `pi` key
(`pi.extensions` -> `./src/index.ts`) and lists the bundled pi core
packages as `peerDependencies` and marks them optional in
`peerDependenciesMeta`, so pi's `npm install` in a git clone does not
vendor the host's bundled packages. There is no build step and no
third-party runtime dependency; pi loads `src/*.ts` in place.

As a flat extension copy:

    bash scripts/install.sh

Re-run to refresh owned copies in place (idempotent; the manifest at
`~/.pi/agent/.pi-cache/manifest.json` records exactly what it owns).
Then run `/reload` in pi (or restart). No config file needed.

## Uninstall

    bash scripts/uninstall.sh

Removes exactly the manifest-owned files, hash-verified against the
manifest so a repurposed path is never deleted. The telemetry ledger,
settings, and bounded backups are left in place;
`bash scripts/uninstall.sh --purge` also removes them plus any stale
temp files.

## Design pillars

1. **Telemetry first** — log per-request `usage.cacheRead` /
   `usage.cacheWrite` and cost from `message_end`; cache economics
   today are measured, not assumed (DeepSeek read pricing conflicts
   across sources: native docs vs OpenRouter's table vs this machine's
   catalog).
2. **Stable prefix normalization** — byte-stable opening messages; split
   the system block into stable (provider prompt + global rules) and
   dynamic (cwd, date, run metadata) regions, mirroring opencode's
   measured 0% -> 97.6% cross-repo hit fix.
3. **Tool-schema hygiene** — dedup and removal of volatile fields (cwd,
   absolute paths) from tool definitions.
4. **Cache-aware compaction** — the trigger is an expected-cost
   probabilistic pressure (coldness and prefix amortization drive it,
   with a context-degradation onset as the occupancy guard); when fast
   compaction is on, the compaction itself is a byte-stable O(1)
   override at pi's own cut point, so the cached prefix head never
   moves. Fast compaction replaces pi's summarizer for all reasons; with
   it off, pi's own normal summarizer runs unchanged in cold/churned
   windows.
5. **Prefix continuance** — a fourth Anthropic cache_control marker
   pinned on stable mid-history at a quantum position (bounds tail-churn
   loss and the >20-block walk-back gap); an opt-in per-request rewrite
   upgrades every marker to the 1h tier (`PI_CACHE_RETENTION_OVERRIDE`);
   the OpenAI `prompt_cache_key` can be derived from the prefix head so
   sibling sessions share a warm bucket (`PI_CACHE_SHARED_KEY`); and
   pi's warming decision is kept warm when its own economics justify it
   and a real turn exists (`PI_CACHE_FORCE_WARM`) — the warming schedule
   follows the tier the per-request rewrite actually put on the wire,
   idle fires defer past an in-flight refresh (margin plus round-trip
   grace), and confirmed refreshes land in the ledger as `warm`-flagged
   rows.
6. **Compaction pressure + fast override** — the trigger is
   `CompactionPressure`, combining the expected-cost economics model
   (`src/economics.ts`) with the context-degradation onset
   (`src/context-degradation.ts`); fast compaction overrides pi's
   summarizer via `session_before_compact` for every reason and
   `session_before_tree` for a wanted branch summary (each with its own
   switch: `PI_CACHE_FAST_COMPACT` / `PI_CACHE_FAST_BRANCH_SUMMARY`);
   the dropped-span digest (`PI_CACHE_FAST_DIGEST`, default on) appends
   a bounded deterministic record after the stub and folds prior digest
   blocks in across compactions.
   `AutocompactController` accounts for every completed compaction (its
   own trigger, pi's threshold/overflow, the override), and cooldowns
   (seconds + turns) gate repetition; `PI_CACHE_FAST_COMPACT=off` (or
   the `/cache-settings` switch) returns to pi's normal summarizer, and
   `PI_CACHE_AUTO_COMPACT=off` disables the trigger entirely.

## Repo layout

- `src/` — extension source (house layout: `index.ts` wiring +
  per-responsibility modules: `ledger.ts`, `sink.ts`, `normalizer.ts`,
  `compaction.ts`, `markers.ts`, `breakpoint-anchor.ts`, `retention.ts`,
  `canonicalizer.ts`, `cache-key.ts`, `warming-policy.ts`,
  `autocompact.ts`, `pressure.ts`, `economics.ts`,
  `context-degradation.ts`, `fastcompact.ts`, `fast-switch.ts`,
  `feature-switch.ts`, `user-settings.ts`, `settings.ts`,
  `settings-view.ts`, `stats.ts`, `temp-sweep.ts`, `constants.ts`)
- `tests/` — zero-dependency validation + OOP/format lint suite
  (`tests/run.ts`, `tests/oop_lint.py`, per-module tests, the installer
  round-trip, and the mock-pi wiring test)
- `docs/research/` — distilled provider/extension evidence and citations
- `docs/design.md` — full design
- `docs/implementation-reference.md` — pi extension API reference
- `docs/web-solutions.md` — surveyed third-party solutions

## Key verified facts

Details and citations in `docs/research/`.

- Anthropic: explicit `cache_control`, 4 breakpoints, 5m/1h TTL, writes
  1.25x/2x, **reads 0.1x**, hits exempt from rate limits.
- OpenAI: implicit + explicit breakpoints, 1,024-token min, 30m TTL,
  writes 1.25x / reads 0.1x, cached tokens count against TPM.
- Gemini: implicit by default (2.5+), ~0.08x cached reads.
- OpenRouter: passthrough + sticky routing keyed on the first
  system/developer + first non-system message; `session_id` forces
  stickiness; `cache_discount` in every response.
- pi 0.86.0: `session_before_compact` may return `{ compaction }` and
  that fully replaces the default summarizer for all reasons
  (`manual`/`threshold`/`overflow`); there is no extension-declared user
  setting, so pi-cache owns `~/.pi/agent/.pi-cache/settings.json`.
- Agent bugs to avoid: volatile tool schemas (opencode #14743), per-turn
  data in cache keys (aider #5556), naive compaction re-writing ~97k
  tokens (claude-code #94197), metering over-counts (#94224).

See `docs/research/README.md` for the sources index.
