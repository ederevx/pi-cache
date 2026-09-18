# pi-cache

A pi coding-agent extension that maximizes LLM prompt-cache hit rate and cuts
token cost. Public research + implementation repo.

## Status

Design, research, and first implementation complete (house-structured,   
OOP, smoke-tested via jiti). Next: adoption into a pi runtime on a      
non-runtime branch, then the paired A/B validation.

## Installation

Copy the `src/` files into the auto-discovered extensions directory:

    mkdir -p ~/.pi/agent/extensions/pi-cache
    cp src/*.ts ~/.pi/agent/extensions/pi-cache/

Then run `/reload` in pi (or restart). No config file needed. All
cache-favoring features are ON by default (tools sort/dedup,
auto-compaction, repeated fast compaction, telemetry); disable any with
its `PI_CACHE_*` env var, e.g. `PI_CACHE_SOFT_COMPACT=off` (see
`src/constants.ts` and `/cache-settings`). Compaction is FAST and
re-arms whenever the live context grows back to `PI_CACHE_SOFT_MIN_TOKENS`
(default ≈ pi's keepRecentTokens; right as older turns would first be
swept into summarized history). Each pass replaces the newest uncached
delta with the SAME fixed byte-stable stub (no summarizer LLM call), so
the `[stable head][stub]` prefix stays byte-identical across all
compactions and cache-warm, while input stays bounded near 2x
keepRecentTokens instead of growing into pi's cold threshold compaction;
the turn is continued once after each pass via a hidden custom message
(no visible "Continue." row; `PI_CACHE_SOFT_AUTORESUME=0` to disable).
`PI_CACHE_SOFT_COMPACT=off` disables this feature.
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
4. **Cache-aware compaction** — keep the cached head intact when trimming;
   adjust effective `keepRecentTokens` and cut alignment via
   `session_before_compact`.
5. **Affinity guardrails** — keep OpenRouter sticky routing warm: one
   `session_id` per thread, never per turn; detect prefix-identity churn.
6. **Repeated fast compaction** — re-arms whenever live context grows
   back to `PI_CACHE_SOFT_MIN_TOKENS` (default ≈ pi's keepRecentTokens,
   the moment older turns would become summarized "history"). Each pass
   replaces only the newest uncached delta with the same fixed byte-stable
   stub, so the `[stable head][stub]` prefix stays byte-identical and
   cache-warm forever while input stays bounded near 2x keepRecentTokens.
   Providers cache on the serialized prefix (Anthropic cumulative
   breakpoint hashes; DeepSeek exact prefix-units + common-prefix
   persistence), so rewriting a compacted span would reset the cache —
   the repeated cadence never does: it only ever drops spans that were
   uncached anyway, and never runs the LLM summarizer that pi's own cold
   threshold compaction would.

## Repo layout

- `src/` — extension source (house layout: `index.ts` wiring + per-
  responsibility modules: `ledger.ts`, `normalizer.ts`, `compaction.ts`,
  `sink.ts`, `constants.ts`)
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