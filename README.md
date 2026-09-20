# pi-cache

A pi coding-agent extension that maximizes LLM prompt-cache hit rate and cuts
token cost. Public research + implementation repo.

## Status

Design, research, and implementation complete (house-structured, OOP,
validated by the zero-dependency suite under `tests/`; see
`tests/run.ts`). Cache-aware compaction has two layers, both on by
default. (1) The auto-compaction trigger is a probabilistic *compaction
pressure* whose probability rises with context tokens and with a graded
cache *coldness* (observed hit share + TTL idle ramp), with a warm-cache
floor and fast compaction relaxing it. (2) When **fast compaction** is
on, pi-cache answers `session_before_compact` for *every* compaction
reason (`manual`/`threshold`/`overflow`) with a byte-stable cache-aware
override that replaces pi's LLM summarizer entirely, and answers a wanted
`/tree` branch summary (`session_before_tree`) the same way. Turn fast
compaction off with the `/cache-settings` switch or
`PI_CACHE_FAST_COMPACT=off`; branch summaries have their own
`PI_CACHE_FAST_BRANCH_SUMMARY` switch, and pi's own normal summarizer runs
for whichever is off. Installed in the pi runtime; paired A/B validation is the
remaining step.

## Installation

    bash scripts/install.sh

Re-run to refresh owned copies in place (idempotent; the manifest at
`~/.pi/agent/.pi-cache/manifest.json` records exactly what it owns).
Then run `/reload` in pi (or restart). No config file needed. All
cache-favoring features are ON by default (tools sort/dedup, session
pin, compaction pressure, fast compaction, advisories, telemetry);
disable any with its `PI_CACHE_*` env var (see `src/constants.ts`) or
with the `/cache-settings` switch (which persists to pi-cache's owned
`~/.pi/agent/.pi-cache/settings.json`). Auto-compaction fires on an idle
`agent_settled` when the pressure draw passes; with fast compaction on
the cache-window gate is relaxed because the override is prefix-stable,
and with it off compaction stays inside cold/churned windows.
Telemetry goes to the `.pi-cache/ledger.jsonl` dot-dir and survives
reloads. The ledger keeps the most recent `PI_CACHE_LEDGER_MAX_ROWS` rows
(default 20000, trimmed on load and at session shutdown), session stats
are rebuilt from it on session start so they survive reloads, and stale
atomic-write temp files are swept at load. Live views: `/cache-stats`
(global and session scopes, with live compaction pressure) and
`/cache-settings`.

## Uninstall

    bash scripts/uninstall.sh

Removes exactly the manifest-owned files, hash-verified against the
manifest so a repurposed path is never deleted. The telemetry ledger and
settings are left in place; `bash scripts/uninstall.sh --purge` also
removes them plus any stale temp files.

## Design pillars

1. **Telemetry first** — log per-request `usage.cacheRead` / `usage.cacheWrite`
   and cost from `message_end`; cache economics today are measured, not
   assumed (DeepSeek read pricing conflicts across sources: native docs vs
   OpenRouter's table vs this machine's catalog).
2. **Stable prefix normalization** — byte-stable opening messages; split the
   system block into stable (provider prompt + global rules) and dynamic
   (cwd, date, run metadata) regions, mirroring opencode's measured
   0% -> 97.6% cross-repo hit fix.
3. **Tool-schema hygiene** — deterministic tool ordering, dedup, and removal
   of volatile fields (cwd, absolute paths) from tool definitions.
4. **Cache-aware compaction** — the trigger is a token-driven
   probabilistic pressure (warm cache discounted, cold cache
   premium-loaded), and when fast compaction is on the compaction itself
   is a byte-stable O(1) override at pi's own cut point, so the cached
   prefix head never moves. Fast compaction replaces pi's summarizer for
   all reasons; with it off, pi's own normal summarizer runs unchanged in
   cold/churned windows.
5. **Affinity guardrails** — keep OpenRouter sticky routing warm: one
   `session_id` per thread, never per turn; detect prefix-identity churn.
6. **Compaction pressure + fast override** — the auto-compaction trigger
   is `CompactionPressure` (probability ramps from 50% to 85% usable
   context, scaled by a graded cache coldness) and **fast compaction**
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
  `compaction.ts`, `affinity.ts`, `session-pin.ts`, `autocompact.ts`,
  `pressure.ts`, `fastcompact.ts`, `fast-switch.ts`, `feature-switch.ts`,
  `user-settings.ts`, `settings.ts`, `stats.ts`, `temp-sweep.ts`,
  `constants.ts`)
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