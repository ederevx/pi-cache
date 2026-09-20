# Semantic-preserving request transforms for cache hits

Evidence: provider prompt-caching documentation and the pi request
serialization audit (see `docs/research/`).

## The lever, precisely

Providers cache on the **token prefix of the serialized request**. There is
no canonicalization inside the provider: identical meaning must produce
byte-identical bytes **across requests**. The lever is *determinism between
requests*, not canonicalism. Anything that reorders JSON keys, drifts
line endings, or re-serializes differently between turns changes tokens and
misses.

## What pi already does right (audit findings)

- No dates/timestamps on the wire (all `Date.now` hits are persistence or
  UI); session id is header-only (`x-session-id`) or `prompt_cache_key`
  (api.openai.com only); never in message content.
- Tools are rebuilt per request from shared `ToolDefinition` objects with
  fixed insertion-order serializers and a fixed literal key order; `parameters`
  passed by reference, strict-mode clones (`constrained-sampling.js:130`).
- Kimi deferred tools, Sets/Maps: insertion-ordered, deterministic.
- No cached request serialization exists (rebuild per call); the hook
  return value replaces the payload (chained), `stream:true` re-asserted
  on the Anthropic path.

**Remaining per-machine nondeterminism in the prefix:**
1. `cwd` is embedded in the system prompt
   (`dist/core/system-prompt.js:9,113` — "Current working directory").
   Stable per session; churns across checkouts. → hoist to a dynamic
   block / last message.
2. Skill and AGENTS.md/prompts listing order comes from raw `readdirSync`
   (`dist/core/skills.js:135`, `resource-loader.js:707`,
   `prompt-templates.js:119`) — deterministic per unchanged directory but
   not lexicographic; absolute `<location>` paths appear in
   `<available_skills>`. → sort deterministically in the loader/fix order
   at the hook when visible.
3. Non-vision models swap images for fixed placeholder strings
   (`transform-messages.js`) — per-model byte variance, not per-time.

## Safe/risky transforms at `before_provider_request`

Checked against both provider serializers (file:line in raw report).

| # | Transform | Risk | Upside |
|---|---|---|---|
| 1 | Freeze-and-pin the tools+stable-system template; reuse byte-verbatim | none | large (0→97% class, opencode-verified) |
| 2 | Deterministic serializer: stable key order, LF-only, no trailing space, stable number/unicode forms; identical bytes on retries | none | large |
| 3 | Split system into stable-first / dynamic-second blocks, markers on stable | none | large |
| 4 | Hoist volatile content (cwd, per-request ids) into the last message | low | medium |
| 5 | Deterministic skill/tool ordering + dedup; strip per-instance fields from schemas | low | medium |
| 6 | Tool-schema diet, but keep prefix ≥ provider cache floor (1,024/2,048/4,096) | low | medium |
| 7 | `session_id` stickiness per thread; keep model constant | none | medium |
| 8 | `ttl:"1h"` on idle-gap sessions; OpenAI explicit mode/30m key | none | medium |
| 9 | Telemetry loop (already built) + probe-based breakpoint tuning | none | medium |
| 10 | Never compact/edit mid-prefix without treating it as a cache reset | low | small-med |

**Illusions:** canonicalism ≠ caching (bytes always matter); reordering
equal text is a semantic change; >4 Anthropic breakpoints or sub-minimum
prefixes waste the feature; 5-min TTL / 10-min sticky expiry silently zero
investments on idle gaps.

## Consequence for existing pi-cache code

`PI_CACHE_SORT_TOOLS=1` currently sorts `payload.tools`, which **moves the
Anthropic/OpenRouter-anthropic `cache_control` marker** that pi-ai pins to
the **last** tool (`anthropic-messages.js:1133-1135`,
`openai-completions.js:837,866`). Sort must re-pin the marker to the new
last tool (implemented in `src/normalizer.ts`), and the immediate-vs-deferred
split must be preserved. Everything else in the list above lands as opt-in
env-gated transforms on the same hook.