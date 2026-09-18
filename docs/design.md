# pi-cache design

Design document for the pi extension that maximizes LLM prompt-cache
hit rate and cuts token cost. Grounded in `docs/research/` findings.

## Goal and success metric

Reduce billed input cost on long agent sessions by raising the share of
input tokens served from prefix caches. Primary metric, per session:

    cache_ratio = cacheRead / (input + cacheRead)

with cost impact measured as `$` avoided = `cost.input - cost.cacheRead`
and a write-churn guard (an optimization that spikes `cacheWrite` without
raising the ratio is a regression).

## Architecture

Single-purpose passes over the per-request payload and per-response usage,
plus a compaction advisory. No semantic rewrites by default; everything is
opt-in and A/B-validated.

### 1. Telemetry (always on, the foundation)

- `message_end` -> accumulate `message.usage{cacheRead, cacheWrite, input,
  output, cost}` per turn and per session; write append-only JSONL to the
  extension's data dir; expose `/cache-stats` via `registerCommand`.
- Uses raw usage fields only (Claude Code #94224 showed derived sums
  over-count ~2.5x).
- Settles open questions with data: DeepSeek read pricing on this machine
  (native 0.1x vs OpenRouter table 1.0x vs catalog 0.2x), real hit-rate on
  the default model, compaction write spikes, TTL expiry patterns.

### 2. Stable-prefix normalization (opt-in, highest ceiling)

Order of operations on the wire (Anthropic hashes tools, then system, then
messages; OpenRouter's default sticky identity hashes the first
system/developer + first non-system message):

- Fetch-open for byte-stable serialization: deterministic tool order
  (sort by name), normalized system text, no reordering.
- **System split** (opencode #14743 pattern, measured 0% -> 97.6% cross-repo
  hit): separate stable region (provider prompt + global rules + static
  skills) from dynamic region (cwd, date, env, session metadata) so dynamic
  content stops invalidating the stable block.
- Pinned tool set: keep the active-tools array stable within and across
  sessions where the agent permits.
- Guardrails: never reorder `tool_use`/`tool_result` pairs; never mutate
  `context` messages (role/association risk); normalize at the payload
  layer only, gated on `ctx.model.provider`.

### 3. Tool-schema hygiene (opt-in, low risk)

- Deterministic sort + exact-schema dedup of `payload.tools`.
- Strip volatile fields (cwd, absolute paths, timestamps) from tool
  definitions into the env/dynamic block (opencode removed
  `Instance.directory` from the bash tool and moved cwd to the env block).
- A/B only: tool order can change model behavior.

### 4. Cache-aware compaction (advisory, opt-in)

- `session_before_compact`: when telemetry shows a warm cache, prefer
  trimming at turn boundaries and raising effective
  `keepRecentTokens` over a summary rebuild (naive compaction rewrote
  ~97k unchanged tokens per event in claude-code #94197).
- Physics note: trimming the head invalidates the prefix at the cut point;
  the win is avoiding churn on the kept tail, not surgical preservation.
- Respect pi's built-in behavior (compaction's own summary request already
  disables cache writes).

### 5. Affinity guardrails (always on, observational)

- Detect per-turn `session_id` / prefix-identity churn and report it
  (`/cache-stats`), keyed to OpenRouter's sticky-routing identity hash.
- Optionally pin TTL policy advice: `PI_CACHE_RETENTION=long` trades 2x
  writes for fewer 1h expiries; recommend based on measured gap-vs-write
  patterns.

## Config surface (`~/pi-cache/cache-opt.json`, extension-owned; pi's
settings.json has no extension namespace)

    {
      "enabled": true,
      "telemetryJsonl": "~/.pi/agent/cache-opt.jsonl",
      "normalizeSystemPrompt": false,
      "splitSystemPrompt": false,
      "sortTools": false,
      "dedupTools": false,
      "stripVolatileToolFields": false,
      "pinnedToolSet": [],
      "compactAdvisory": true,
      "minCacheMissNoticeTokens": 1024
    }

## Validation plan

Same-day paired A/B (controls provider-TTL drift): baseline passive
extension vs active, N >= 10 sessions x M >= 20 prompts, fixed workload
and models. Compare `cache_ratio`, `$` saved, `cacheWrite` churn, plus
non-regression signals (tool-call success, answer diff). pi-ai's `faux`
provider (simulated cache) gives offline harness tests.

## Non-goals

- No response/semantic caching (GPTCache et al. cache answers, not
  prefixes; complementary but out of scope).
- No core pi changes for the MVP; no provider-side KV control.
- No semantic rewriting without opt-in; byte-stability beats cleverness.

## Risks

- Semantic drift from system splitting -> A/B, defaults off.
- Provider variance (Bedrock vs OpenAI vs Anthropic payload semantics) ->
  gate every transform on model/queue compat flags.
- Min-size misses: prefixes below the provider minimum never cache; do not
  pad (providers say padding is wasted write spend).
- Sticky-routing breakage from opening-message edits -> treat the first
  system + first user message as frozen content.