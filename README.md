# pi-cache

A pi coding-agent extension that maximizes LLM prompt-cache hit rate and cuts
token cost. Public research + implementation repo.

## Status

Design, research, and implementation complete (house-structured, OOP,
validated by the zero-dependency suite under `tests/`; see
`tests/run.ts`). Cache-aware compaction has two layers, both on by
default. (1) The auto-compaction trigger is a probabilistic *compaction
pressure* that blends context degradation as the window is approached
with the expected cost of continuing versus rewriting the prefix
(cache write amortization, coldness, TTL idle ramp), with a warm-cache
floor and fast compaction relaxing it. (2) When **fast compaction** is
on, pi-cache answers `session_before_compact` for *every* compaction
reason (`manual`/`threshold`/`overflow`) with a byte-stable cache-aware
override that replaces pi's LLM summarizer entirely, and answers a wanted
`/tree` branch summary (`session_before_tree`) the same way. Turn fast
compaction off with the `/cache-settings` switch or
`PI_CACHE_FAST_COMPACT=off`; branch summaries have their own
`PI_CACHE_FAST_BRANCH_SUMMARY` switch, and pi's own normal summarizer runs
for whichever is off. The cache TTL that drives the idle trigger and the
compaction-pressure ramp falls back to `PI_CACHE_TTL_SECONDS` (default
300 s) when the model declares no `promptCache` tier. Installed in the
pi runtime; paired A/B validation is the
remaining step.

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
Then run `/reload` in pi (or restart). No config file needed. The cache-favoring request transforms are ON by
default (tool dedup, mid-history breakpoint anchor, system-listing
canonicalization, compaction pressure, fast compaction, advisories,
telemetry); the per-request long-retention override, shared OpenAI
cache key, and forced warming are opt-in. Disable any
feature with its `PI_CACHE_*` env var (see `src/constants.ts`) or
with the `/cache-settings` switch (which persists to pi-cache's owned
`~/.pi/agent/.pi-cache/settings.json`; a set env var pins its row). Auto-compaction fires at three
idle points when the pressure draw passes: after a turn settles
(`agent_settled`), on a session-scoped timer when the provider cache TTL
expires while pi sits idle (`PI_CACHE_IDLE_TRIGGER`), and when a cold
prompt arrives before a turn (the `input` handler defers the prompt until
compaction finishes, `PI_CACHE_BEFORE_TURN`). With fast compaction on the
cache-window gate is relaxed because the override is prefix-stable, and
with it off compaction stays inside cold/churned windows.
Telemetry goes to the `.pi-cache/ledger.jsonl` dot-dir and survives
reloads. The ledger keeps the most recent `PI_CACHE_LEDGER_MAX_ROWS` rows
(default 20000, trimmed on load, in-session once a full window of
appends accumulates, and at session shutdown), a bounded
pre-trim backup is captured before any shrinking rewrite
(`PI_CACHE_LEDGER_BACKUPS`/`_TTL_DAYS`/`_MAX_MB`), session stats are
rebuilt from it on session start so they survive reloads, and stale
atomic-write temp files are swept at load. Live views: `/cache-stats`
(global and session scopes, with live compaction pressure) and
`/cache-settings`.

## Uninstall

    bash scripts/uninstall.sh

Removes exactly the manifest-owned files, hash-verified against the
manifest so a repurposed path is never deleted. The telemetry ledger,
settings, and bounded backups are left in place; `bash
scripts/uninstall.sh --purge` also removes them plus any stale temp files.

## Design pillars

1. **Telemetry first** — log per-request `usage.cacheRead` / `usage.cacheWrite`
   and cost from `message_end`; cache economics today are measured, not
   assumed (DeepSeek read pricing conflicts across sources: native docs vs
   OpenRouter's table vs this machine's catalog).
2. **Stable prefix normalization** — byte-stable opening messages; split the
   system block into stable (provider prompt + global rules) and dynamic
   (cwd, date, run metadata) regions, mirroring opencode's measured
   0% -> 97.6% cross-repo hit fix.
3. **Tool-schema hygiene** — dedup and removal
   of volatile fields (cwd, absolute paths) from tool definitions.
4. **Cache-aware compaction** — the trigger is an expected-cost
   probabilistic pressure (coldness and prefix amortization drive it,
   with a context-degradation onset as the occupancy guard), and when fast
   compaction is on the compaction itself
   is a byte-stable O(1) override at pi's own cut point, so the cached
   prefix head never moves. Fast compaction replaces pi's summarizer for
   all reasons; with it off, pi's own normal summarizer runs unchanged in
   cold/churned windows.
5. **Prefix continuance** — a fourth Anthropic cache_control marker is
   pinned on stable mid-history at a quantum position (bounds tail-churn
   loss and the >20-block walk-back gap), an opt-in per-request rewrite
   upgrades every marker to the 1h tier (`PI_CACHE_RETENTION_OVERRIDE`),
   the OpenAI `prompt_cache_key` can be derived from the prefix head so
   sibling sessions share a warm bucket (`PI_CACHE_SHARED_KEY`), and
   pi's warming decision is kept warm when its own economics justify it
   (`PI_CACHE_FORCE_WARM`) — pi schedules refreshes from its
   request-scoped retention tier, so the warming schedule follows the
   tier the per-request rewrite actually put on the wire.
6. **Compaction pressure + fast override** — the auto-compaction trigger
   is `CompactionPressure`, combining the expected-cost economics model
   (`src/economics.ts`) with the context-degradation onset
   (`src/context-degradation.ts`); fast compaction
   overrides pi's summarizer via `session_before_compact` for every reason
   and `session_before_tree` for a wanted branch summary (each with its own
   switch: `PI_CACHE_FAST_COMPACT` / `PI_CACHE_FAST_BRANCH_SUMMARY`).
   `AutocompactController` also accounts for every completed
   compaction (its own trigger, pi's threshold/overflow, the override),
   and cooldowns (seconds + turns) gate repetition;
   `PI_CACHE_FAST_COMPACT=off` (or the `/cache-settings` switch) returns
   to pi's normal summarizer, and `PI_CACHE_AUTO_COMPACT=off` disables
   the trigger entirely.

## Repo layout

- `src/` — extension source (house layout: `index.ts` wiring + per-
  responsibility modules: `ledger.ts`, `sink.ts`, `normalizer.ts`,
  `compaction.ts`, `markers.ts`, `breakpoint-anchor.ts`,
  `retention.ts`, `canonicalizer.ts`, `cache-key.ts`, `warming-policy.ts`,
  `autocompact.ts`,
  `pressure.ts`, `economics.ts`, `context-degradation.ts`,
  `fastcompact.ts`, `fast-switch.ts`, `feature-switch.ts`,
  `user-settings.ts`, `settings.ts`, `settings-view.ts`, `stats.ts`,
  `temp-sweep.ts`, `constants.ts`)
- `tests/` — zero-dependency validation + OOP/format lint suite
  (`tests/run.ts`, `tests/oop_lint.py`, per-module tests, the
  installer round-trip, and the mock-pi wiring test)
- `docs/research/` — distilled provider/extension evidence and citations
- `docs/design.md` — full design
- `docs/implementation-reference.md` — pi extension API reference
- `docs/web-solutions.md` — surveyed third-party solutions

## Key verified facts (details and citations in docs/research/)

- Anthropic: explicit `cache_control`, 4 breakpoints, 5m/1h TTL,
  writes 1.25x/2x, **reads 0.1x**, hits exempt from rate limits.
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
  data in cache keys (aider #5556), naive compaction re-writing ~97k tokens
  (claude-code #94197), metering over-counts (#94224).

See `docs/research/README.md` for the sources index.
