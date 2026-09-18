# pi-cache

A pi coding-agent extension that maximizes LLM prompt-cache hit rate and cuts
token cost. Public research + implementation repo.

## Status

Design and research phase; implementation reference and extension skeleton land
next. Everything here is evidence-based: provider mechanics were verified
against official docs (Sep 2026), and the agent-framework findings come from
codebases, issues, and PRs (Claude Code, aider, opencode).

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

## Repo layout

- `src/` — extension source (landing next)
- `docs/research/` — evidence: distilled reports + raw worker/evidence dumps
- `docs/design.md` — full design (in progress)
- `docs/implementation-reference.md` — pi extension API reference (in progress)
- `docs/web-solutions.md` — surveyed third-party solutions (in progress)

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