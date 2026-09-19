# pi-cache

A pi coding-agent extension that maximizes LLM prompt-cache hit rate and cuts
token cost. Public research + implementation repo.

## Status

Design, research, and implementation complete (house-structured, OOP,
validated by the zero-dependency suite under `tests/`; see
`tests/run.ts`). Soft fast compaction and its compact store were
removed: cache-aware cold-window auto-compaction is now the single
compaction path, on by default, with pi's own normal summarizer
compaction left untouched. Installed in the pi runtime; paired A/B
validation is the remaining step.

## Installation

Copy the `src/` files into the auto-discovered extensions directory:

    mkdir -p ~/.pi/agent/extensions/pi-cache
    cp src/*.ts ~/.pi/agent/extensions/pi-cache/

Then run `/reload` in pi (or restart). No config file needed. All
cache-favoring features are ON by default (tools sort/dedup, session
pin, cold-window auto-compaction, advisories, telemetry); disable any
with its `PI_CACHE_*` env var (see `src/constants.ts` and
`/cache-settings`). Auto-compaction fires only in cold windows (the
provider cache is already lost) or when the prefix head churns / the
provider session affinity rotates — never mid-warm-cache — and pi's
own normal summarizer compaction runs unchanged.
Telemetry goes to the `.pi-cache/ledger.jsonl` dot-dir and survives
reloads. Live views: `/cache-stats` and `/cache-settings`.

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
4. **Cache-aware compaction** — compact only when the provider cache is
   already lost: a cold last turn (TTL expiry after a gap) or a
   churning/rotating prefix head, at idle (`agent_settled`). Pi's own
   normal summarizer compaction then runs unchanged; the advisory
   observes warm-cache re-writes without altering them.
5. **Affinity guardrails** — keep OpenRouter sticky routing warm: one
   `session_id` per thread, never per turn; detect prefix-identity churn.
6. **Cold-window auto-compaction** — the single compaction path, on by
   default (`PI_CACHE_AUTO_COMPACT`). After a turn with ~0 cacheRead at
   context above the threshold — or when the tool/system prefix head is
   churning or the provider session-affinity header is rotating, both of
   which already invalidate the provider cache — `ctx.compact()` fires
   at idle ahead of pi's own cold threshold compaction. Cooldowns
   (seconds + turns) gate repetition; `PI_CACHE_AUTO_COMPACT=off`
   disables it entirely.

## Repo layout

- `src/` — extension source (house layout: `index.ts` wiring + per-
  responsibility modules: `ledger.ts`, `normalizer.ts`, `compaction.ts`,
  `affinity.ts`, `session-pin.ts`, `autocompact.ts`, `sink.ts`,
  `settings.ts`, `constants.ts`)
- `tests/` — zero-dependency validation suite (`run.ts` + per-module
  tests, including an end-to-end mock-pi wiring test)
- `docs/research/` — evidence: distilled reports + raw worker/evidence dumps
- `docs/design.md` — full design
- `docs/implementation-reference.md` — pi extension API reference
- `docs/web-solutions.md` — surveyed third-party solutions

## Key verified facts (details in docs/research/)

- Anthropic: explicit `cache_control`, 4 breakpoints, 5m/1h TTL,
  writes 1.25x/2x, **reads 0.1x**, hits exempt from rate limits.
- OpenAI: implicit + explicit breakpoints, 1,024-token min, 30m TTL,
  writes 1.25x / reads 0.1x, cached tokens count against TPM.
- Gemini: implicit by default (2.5+), ~0.08x cached reads.
- OpenRouter: passthrough + sticky routing keyed on the first
  system/developer + first non-system message; `session_id` forces
  stickiness; `cache_discount` in every response.
- Agent bugs to avoid: volatile tool schemas (opencode #14743), per-turn
  data in cache keys (aider #5556), naive compaction re-writing ~97k tokens
  (claude-code #94197), metering over-counts (#94224).

See `docs/research/README.md` for the sources index.