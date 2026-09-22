# Prompt formatting for caching and cache continuation

Research 2026-09-22. Fresh fetches of official provider docs plus an
inventory of the installed pi 0.87.0 / pi-ai 0.87.0 request pipeline.
Extends `request-cache-transforms.md` (byte-stability levers) and
`web-solutions.md` (prior art) with provider continuation semantics and
the currently unused levers. Implementation deliberately held off.

## Cache continuation semantics (does a read extend TTL?)

| Provider | Refresh on hit | Notes |
|---|---|---|
| Anthropic 5m | Yes | "refreshed for no additional cost each time the cached content is used"; lifetime measured from request start |
| Anthropic 1h | Undocumented | refresh-on-read not stated |
| OpenAI | Yes | reuse refreshes the lifetime "without another cache-write charge" (ttl 30m, retention 24h) |
| Kimi/Moonshot | Yes | each hit resets the entry to its original TTL for free; TTL locked at first write |
| DeepSeek | Undocumented | no TTL parameter; entries clear hours to days after last use |
| z-ai GLM | Undocumented | "reasonable time limits, will recalculate after expiration" |
| Gemini | Undocumented | implicit TTL unstated; explicit cache TTL fixed at creation |

Practical consequence: only OpenAI and Kimi (and Anthropic at 5m) give
confirmed indefinite continuation from reads alone; DeepSeek, z-ai, and
Gemini must be treated as rewrite-on-expiry.

## Formatting levers (request shape that favors hits)

| # | Lever | Providers | Effect |
|---|---|---|---|
| 1 | Byte-stable prefix serialization | all | hit requires 100% identical prefix; any earlier byte change kills all downstream continuation |
| 2 | Explicit breakpoints on stable blocks only (a marker on a varying block never hits) | Anthropic (max 4), OpenAI GPT-5.6+ explicit mode, Kimi Messages API | controls where writes land |
| 3 | Anthropic automatic top-level `cache_control`: auto breakpoint on the last cacheable block, moves forward, uses 1 of 4 slots; 400 on conflicting/duplicate TTLs or 4 explicit slots taken | Anthropic (new) | continuation as the conversation grows without manual markers |
| 4 | Stable-first / dynamic-last placement; no timestamps, random ids, or volatile fields in the prefix; append-only history | all (explicit guidance in OpenAI, Kimi docs; Anthropic common-mistake example) | direct hit-rate lever |
| 5 | Request hierarchy: a change at a level invalidates it and everything after; tool-definition change invalidates the ENTIRE cache; tool_choice/images change messages only; thinking config and effort are rendered into the prompt | Anthropic, OpenAI | pin these stable for continuation |
| 6 | Walk-back is bounded: Anthropic reads walk back 1 block at a time, max 20 positions per breakpoint (a tool_use/tool_result run counts as 1); an extra explicit breakpoint starts a second window | Anthropic | long sessions need a second breakpoint before the gap exceeds 20 blocks |
| 7 | Minimum cacheable prefix: Anthropic 512-4096 per model (silent no-cache below), OpenAI 1024, Gemini 2048/4096, Kimi 256 | all | below the floor nothing is cached |
| 8 | TTL selection: Anthropic `ttl` 5m/1h (1h write = 2x base input; mixed TTLs order long-before-short); OpenAI ttl 30m, retention 24h/`in_memory`; Kimi ttl 5m/1h; Gemini explicit ttl Duration | all | sets the continuation window |
| 9 | `prompt_cache_key` (OpenAI): routing bucket (~15 rpm/key pre-GPT-5.6) | OpenAI | indirect hit rate; stable per-session key |
| 10 | Prewarm: Anthropic `max_tokens:0` with an explicit breakpoint on a block shared with the real request (same thinking/effort); OpenAI `prompt_cache_options.prewarm` | Anthropic, OpenAI | warm the cache before real traffic |
| 11 | Append-only tool loading: dynamic tools appended to the END of messages with declarations carried unchanged; core tools stable in top-level `tools` | Kimi (dynamic tool loading), OpenAI (deferred/allowed tools) | add capability without breaking the prefix |
| 12 | Prefix-preserving config changes: mid-conversation Anthropic system messages (Opus 4.8/Opus 5/Fable/Mythos, not Sonnet 5) + per-message effort; OpenAI `configuration_update` input item | Anthropic, OpenAI | change behavior without a rewrite |
| 13 | Thinking-block stripping: non-tool-result user content drops prior thinking blocks from cache on older Opus/Sonnet + all Haiku; Opus 4.5+/Sonnet 4.6+ keep them | Anthropic | model-specific continuation hazard |
| 14 | Storage fees: z-ai "Cached Input Storage" (currently limited-time free); DeepSeek on-disk storage free | z-ai, DeepSeek | cost side of long retention |

## Installed pi 0.87 baseline (verified, file:line in pi-ai dist/api)

- THREE Anthropic breakpoints already emitted: first system block
  (anthropic-messages.js:823-851), last tool (:1177), and the last block
  of the last user/system message (:1107-1133). 3 of 4 slots used.
- OpenAI-compat Anthropic-style markers mirror this for
  openrouter `anthropic/*` models (openai-completions.js:808-812, 1256).
- `ttl` "1h" (Anthropic), "30m" + retention "24h" (OpenAI) emitted only
  when retention is long; selection is per-request `options.cacheRetention`
  (pi never sets it) else `PI_CACHE_RETENTION` env via
  getProviderEnvValue (anthropic-messages.js:21-37,
  openai-completions.js:575-579). pi-cache's `PI_CACHE_RETENTION=long`
  therefore already reaches both providers end to end.
- `prompt_cache_key` = clamped session id, only for api.openai.com
  (or retention long + compat) — not sent for openrouter or others.
- No caching parameters exist anywhere for Kimi/GLM/DeepSeek in pi-ai;
  DeepSeek and z-ai caching is fully server-side implicit.
- pi 0.87 already includes the message-level (third) breakpoint that
  pi-better-messages-cache pioneered; that extension stays deprecated.

## Remaining volatile prefix bytes in pi 0.87

- `cwd` in the system prompt (system-prompt.js:105) — stable per session,
  differs per spawn dir. Not safely canonicalizable (the model resolves
  paths against it).
- Skill listing order from unsorted `readdirSync` (skills.js:135, 317-406)
  rendered into the system prompt (system-prompt.js:131-136) —
  canonicalizable at the hook.
- AGENTS.md context-file order (resource-loader.js →
  system-prompt.js:31-35) — same.
- Biggest structural churn: tool-loadout / custom-section changes emit a
  MID-CONVERSATION system sections-patch message
  (agent-session.js:1017-1032), invalidating everything after the system
  marker. Hook-visible but not safely suppressible — needs a pi core
  change (quantize loadouts or move volatile sections to a tail message).

## Ranked levers for pi-cache (implementation held off)

1. Suppress/quantize mid-conversation system sections-patches — largest
   full-miss source for multi-loadout sessions; requires a pi core
   change, not hook-safe.
2. Fourth Anthropic breakpoint pinning the stable mid-history head —
   bounds tail-churn loss to the tail; hook-implementable; must respect
   the existing mid-array markers (src/normalizer.ts re-pins the last).
3. Per-request ttl/retention rewrite at the hook (cache_control
   ttl:"1h", prompt_cache_retention:"24h") instead of process-wide env —
   multi-hour sessions keep prefixes across idle gaps; 2x write premium
   on Anthropic 1h.
4. Canonicalize skills/context listing order at the hook — cross-spawn
   head stability; low risk.
5. Shared/derived `prompt_cache_key` for OpenAI sibling buckets;
   hook-implementable, low risk.
6. `cache_warming_decision` override to drive warm/stop per provider
   economics (e.g. force warm inside GLM's ~120s knee); hook exists,
   unimplemented; watch cost discipline.

Not recommended: cwd canonicalization (breaks path resolution); Kimi
context-cache API integration (new pi core/provider work).

## Sources consulted

- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.openai.com/docs/guides/prompt-caching
- https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api
- https://docs.z.ai/guides/overview/pricing (cached-input storage)
- https://api-docs.deepseek.com/guides/kv_cache
- https://ai.google.dev/gemini-api/docs/caching (Gemini explicit/implicit)
- pi 0.87.0 dist source: pi-ai anthropic-messages.js, openai-completions.js,
  openai-responses.js; pi agent-session.js, system-prompt.js, skills.js.
