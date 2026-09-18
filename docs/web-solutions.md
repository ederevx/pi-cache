# Surveyed third-party solutions (web sweep, 2026-09-18)

Provenance: `public web sources`. Tags: [V] verified from
fetched bytes, [K] knowledge/unverified. Repo stars and URLs current at
sweep time.

## What exists out there (and where the gap is)

No public project does pi-cache's full job (stable-prefix normalization +
rewrite + cache telemetry together). Nearest analogues:

| Project | Stars | Mechanism | Verdict for pi-cache |
|---|---|---|---|
| montevive/autocache | 171 | [V] local proxy injecting `cache_control` into Anthropic requests, "up to 90% cost cut" | proves demand; naive-injection only, no prefix normalization/telemetry |
| alxsuv/pino | 54 | [V] Anthropic reverse proxy: prompt-cache injection + body transforms | same category |
| mcowger/pi-better-messages-cache | 18 | [V] **pi extension** with dual cache breakpoints (last tool_use + last user/tool-result) | **deprecated for Pi 0.80.6+** which built caching into the Anthropic provider (pi#1737); pi-cache must complement, not regress, built-ins |
| os-tack/ostk-cache | 9 | [V pitch] anchors long-lived context into stable boundaries | closest to our stable-prefix anchor idea |
| umans-gate | - | [V pitch] cache_control TTL stamping + inspection dashboard | confirms demand for observability |
| MukundaKatta/prompt-cache-key | - | [V pitch] hashes prefix up to last breakpoint for a shared warm cache | shared-cache-keys pattern |
| dthinkr/claude-code-workarounds | - | [V pitch] auto-compacts **before the cache goes cold** | TTL-aware client pacing |

Plus OpenWebUI filter injecting OpenRouter/Anthropic cache_control [V], and
a long tail of small proxies. None with verifiable hit-rate numbers.

## Aider source-confirmed mechanics [V]

- **Rolling breakpoint ("write reduction")**: `aider/coders/chat_chunks.py`
  `add_cache_control_headers()` puts `{"type":"ephemeral"}` on the last
  message of each stable chunk only (system/examples, repo+readonly files,
  chat_files). The mutable conversation tail stays **outside** the cached
  prefix, so every request re-writes only a small delta instead of the
  growing history. This is the technique to mirror.
- **Keepalive**: `aider/coders/base_coder.py` — `warm_cache()`,
  `AIDER_CACHE_KEEPALIVE_DELAY`, pings every 5 min to roll the Anthropic
  TTL. Community reports it underperforms (#4372); use sparingly.
- Streaming hides usage stats (use non-stream to read them) — caveat for
  our telemetry.

## Known gaps / deltas

- opencode moved `sst/opencode` -> `opencode-ai/opencode` (13.7k★); no
  substantive public cache-opt issue found (#201 is a question).
- No OSS prefill/"continue" prefix-extension implementation exists [K];
  speculative — `cache_control` placement is the safer lever.
- Semantic caches (GPTCache, LiteLLM semantic, LangSmith) cache whole
  responses, not prefixes — complementary, out of scope.
- Citation URLs: use `openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/`,
  `openrouter.ai/docs/features/prompt-caching`, `aider.chat/docs/usage/caching.html`,
  `code.claude.com/docs/en/iam` (the `.ai` domain is unreachable from here;
  `code.claude.ai` returned 000).

## Implications for pi-cache

1. Precedent warning: Pi >= 0.80.6 already injects Anthropic cache markers;
   pi-cache hooks must be additive (split/normalize/hygiene/telemetry),
   never re-add what the provider layer already does.
2. The room: byte-stable prefixes + volatile-tool-schema removal +
   read/write telemetry with miss-cause classification.
3. Keepalive: implement as opt-in only, with measured cost/benefit.
4. Cite aider's chunk-breakpoint code as the reference pattern, and
   OpenRouter's write/read pricing for the telemetry math.