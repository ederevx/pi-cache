# Internet research: provider prefix-cache semantics (2026-09-18)

Fetched with curl by the researcher and extracted to
plain text. Quotes are verbatim from the fetched pages; the raw fetches were
scratch under `~/tmp/pi-cache-research/` (garbage-collected; the quotes
below are the durable record).

Sources consulted:
- https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- https://api-docs.deepseek.com/guides/kv_cache/
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://code.claude.com/docs/en/memory

## Anthropic prompt caching

- "Cache writes happen only at your breakpoint." ... "Because the hash is
  cumulative, covering everything up to and including the breakpoint,
  changing any block at or before the breakpoint produces a different hash
  on the next request."
- "On each request the system computes the prefix hash at your breakpoint
  and checks for a matching cache entry. If none exists, it walks backward
  one block at a time, checking whether the prefix hash at each earlier
  position matches something already in the cache. It is looking for prior
  writes, not for stable content."
- "The system checks at most 20 positions per breakpoint, counting the
  breakpoint itself as the first."
- "The system automatically applies the cache breakpoint to the last
  cacheable block and moves it forward as conversations grow. Best for
  multi-turn conversations where the growing message history should be
  cached automatically."
- "You can use just one cache breakpoint at the end of your static content,
  and the system will automatically find the longest prefix that a prior
  request already wrote to the cache."
- Minimum cacheable prompt length is model/platform-specific (1024 tokens
  for Claude models per the page's tables); "Cache reads cost significantly
  less than uncached input tokens."

## DeepSeek context caching

- "A cache hit requires that the corresponding prefix has already been
  'persisted' (written to the disk cache). Due to the Sliding Window
  Attention mechanism, the storage and matching of cached prefixes differs
  from before. Each cached prefix is an independent, complete unit. A
  subsequent request can only hit the cache if it fully matches a cache
  prefix unit."
- "Each request will produce two cache prefix units at the end position of
  the user input and the end position of the model output."
- "Common prefix detection persistence: When the system detects a common
  prefix across multiple requests, it will persist that common prefix as
  an independent cache prefix unit."

## OpenAI prompt caching

- "prefix: the unchanged tokens at the beginning of a prompt. When a later
  request has the same prefix and finds a matching cache entry, the model
  can reuse the saved state instead of processing those tokens again."
- "Cache reuse requires the entire rendered prefix to match. If content or
  a relevant setting changes before a breakpoint, the prefix after that
  change cannot match the existing cache entry."
- Explicit breakpoints: "The first request writes an eligible prefix to the
  cache and subsequent requests look for the longest matching cached
  prefix available, working backward through eligible breakpoints until
  they find a match." Minimum prefix 1024 tokens; writes 1.25x, reads 0.1x.

## Context engineering (Anthropic)

- "Compaction is the practice of taking a conversation nearing the context
  window limit, summarizing its contents, and reinitiating a new context
  window with the summary. Compaction typically serves as the first lever
  in context engineering to drive better long-term coherence."
- "One of the safest lightest touch forms of compaction is tool result
  clearing."

## Claude Code memory

- Project-root CLAUDE.md survives compaction; compaction and prompt caching
  are documented first-class behaviors there.

## Design conclusions used by the repeated cadence

1. All three providers cache on the exact serialized prefix; a change at or
   before a breakpoint invalidates everything from that point.
2. Replacing a middle span with the SAME fixed stub preserves the cached
   [stable head][stub] prefix (byte-identical); the dropped span was
   uncached anyway.
3. DeepSeek's common-prefix persistence is the friendliest case for a
   repeated-stub head; Anthropic's 20-block walk-back finds prior writes
   up to the stub; OpenAI requires full prefix match (one re-write of the
   kept window after each compaction, then warm again).

## Cache coldness (2026-09-20)

Fresh sweep by three research workers; each claim carries its fetched URL.

### Provider lifetimes (all refresh-on-reuse unless noted)

- Anthropic: 5 min default, 1 h optional; lifetime starts at request start
  and "is refreshed each time the cached content is used". Reads 0.1x,
  writes 1.25x/2x; no manual clear; a 20-block look-back means a changed
  breakpoint block finds nothing behind it.
  https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- OpenAI: implicit by default; GPT-5.6+ "remains eligible for reuse for 30
  minutes after its most recent write or reuse"; older `in_memory` ~5-10
  min of inactivity (up to 1 h). Per-machine caches plus "overflow routing"
  above ~15 rpm can cold a prefix early.
  https://platform.openai.com/docs/guides/prompt-caching
- Gemini: implicit on by default (min 2,048-4,096); explicit TTL defaults
  to 1 h and is settable, with storage billed. OpenRouter documents its own
  Gemini layer as a fixed 5 min (conflict).
  https://ai.google.dev/gemini-api/docs/generate-content/caching
- DeepSeek: exact prefix units, no TTL - "automatically cleared, usually
  within a few hours to a few days", best-effort.
  https://api-docs.deepseek.com/guides/kv_cache
- OpenRouter: sticky routing keyed on the first system + first non-system
  message (or `session_id`); "Sticky sessions expire after 10 minutes of
  inactivity. Each successful request resets the timer."
  https://openrouter.ai/docs/features/prompt-caching

### Client observability

- Hits/writes: OpenAI `prompt_tokens_details.cached_tokens` /
  `cache_write_tokens`; Anthropic `cache_read_input_tokens` /
  `cache_creation_input_tokens`; DeepSeek `prompt_cache_hit_tokens`;
  OpenRouter normalizes these and adds `cache_discount`.
- A write is not proof of cold (writes happen at breakpoints; partial hits
  write a new extension); below-minimum prompts return all-zero cache
  fields with no error. Anthropic cache diagnostics (beta) is the only
  documented TTL-expiry vs prefix-change discriminator.
  https://docs.anthropic.com/en/docs/build-with-claude/cache-diagnostics
- Because TTL is sliding, `now - last_request` only lower-bounds expiry;
  track the last write/reuse. No provider or tool publishes a graded
  coldness score; per-request signals are effectively binary.

### pi 0.86 model (reusable)

- `model.promptCache` declares per-tier lifetimes in seconds; the catalog
  fills Anthropic 300/3600 and leaves other providers unset.
  docs/models.md#prompt-cache-lifetimes
- Warming refreshes at 90% of TTL minus 10 s; `continuationProbability` is
  0.15 idle / 1.0 while active; `expectedSavings = p*missCost - warmCost`;
  pi warms at >= $0.05 (cache-warmer.js:4-19,267-286).
- The `cache_warming_decision` event exposes `warmCost`/`missCost`/
  `continuationProbability`/`action` and is extension-overridable; the
  extension ctx exposes `model`/`isIdle()`/`getContextUsage()` but not the
  TTL or `nextWarmAt`.
