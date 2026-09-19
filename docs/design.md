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

### 5. Cache-aware auto-compaction (opt-in, off by default)

Question under evaluation/implementation: use the telemetry itself to drive
compaction timing, and trigger it automatically.

**Policy (cold-window clustering).** Compaction invalidates the prefix at
its cut point, and the summarizer + next full re-write are the expensive
part. Paying those costs inside a *warm* window wastes the hits; the
optimal time to compact is when the cache is already cold:

1. At `turn_end`, if the just-completed turn showed ~0 `cacheRead` (the
   provider prefix was lost anyway: TTL expiry after a gap, provider move,
   head churn) AND `getContextUsage().percent` is at/above the threshold,
   call `ctx.compact()` — the re-write lands in a window that would be
   charged fresh regardless.
2. While the cache is warm and context is below the threshold, do nothing
   (keep harvesting hits; defer the inevitable compaction).
3. Strict guardrails: opt-in via `PI_CACHE_AUTO_COMPACT=1`; cooldown
   (min turns + min seconds after any compaction/summary); never fire
   while streaming or when core reports overflow recovery (`willRetry`);
   never fire when a compaction is already in progress; all decisions in
   one `AutocompactController` class owned by the factory.

**Expected effect.** Avoid the common pattern of a forced compaction
mid-warm-cache plus full re-write shortly after; the write churn is moved
into already-cold windows. Side benefit: fewer `1h`/`30m` TTL expiries on
idle-with-growth. Risk: an extra summarizer call per event (~few k tokens)
and task-coherence churn if triggered mid-task — mitigated by threshold +
cooldown + opt-in, validated by comparing `cacheWrite` before/after.

Feasibility confirmed by the capability audit (`the pi 0.86 extension API`):
`ctx.compact({customInstructions, onComplete, onError})` is fire-and-forget
(`void`); compaction summaries are cache-transparent (`cacheRetention:"none"`,
fresh routing session), so the trigger only times the *next* turn's re-write.
The safe point is `agent_settled` (guaranteed idle — no pending retry or
overflow recovery), not `turn_end` (compact() aborts live
work). Guards in code: `agent_settled` + `ctx.isIdle()` + cooldown
(turns/seconds) + last-entry-compaction check via pi's own stale guards;
opt-in `PI_CACHE_AUTO_COMPACT`.

### 6. Affinity guardrails (always on, observational)

- Detect per-turn `session_id` / prefix-identity churn and report it
  (`/cache-stats`), keyed to OpenRouter's sticky-routing identity hash.
- Optionally pin TTL policy advice: `PI_CACHE_RETENTION=long` trades 2x
  writes for fewer 1h expiries; recommend based on measured gap-vs-write
  patterns.

## Config surface

House-consistent, not a config JSON: tunables live in
`src/constants.ts` and are overridable with `PI_CACHE_*` environment
variables (mirroring the env-var idiom of pi extensions):

- `PI_CACHE_TELEMETRY` (default true), `PI_CACHE_SORT_TOOLS`,
  `PI_CACHE_DEDUP_TOOLS`, `PI_CACHE_ADVISORY` (default true)
- `PI_CACHE_LEDGER` (default `~/.pi/agent/.pi-cache/ledger.jsonl` —
  hidden dot-dir, house-consistent convention)

Durable per-session state also goes through `pi.appendEntry`
(`pi-cache-advisory`), the house-standard mechanism.

No first-run template file is written; the ledger directory is created
on demand as runtime data.

## Validation plan

Same-day paired A/B (controls provider-TTL drift): baseline passive
extension vs active, N >= 10 sessions x M >= 20 prompts, fixed workload
and models. Compare `cache_ratio`, `$` saved, `cacheWrite` churn, plus
non-regression signals (tool-call success, answer diff). pi-ai's `faux`
provider (simulated cache) gives offline harness tests.

## Soft compaction (cache-first, repeated FAST by default) — SPEC

> **Removed 2026-09-18.** Soft fast compaction and its compact store were
> dropped from the implementation and are no longer wired; the cold-window
> auto-compaction path (`src/autocompact.ts`, on by default) is the single
> compaction mode and pi's own summarizer compaction runs unchanged. This
> section is retained as the historical design record only.

**Definition.** Fast "soft" compaction whose ONLY purposes are better cache
hits and fewer input tokens, re-armed whenever the live context grows back
to the threshold. Invariant, by the user's requirement: **soft compaction
must never touch already-soft-compacted segments — they are already cached;
touching them would invalidate their prefix.** The repeated cadence keeps
that invariant: every pass replaces ONLY the newest uncached delta (the span
pi's own cut marks for summarization) with the SAME byte-stable stub, so the
[stable head][stub] prefix never moves.

Consequences of the invariant:
- Stable prefix (system + tools) and every previously soft-compacted
  span stay byte-identical in every request, forever, and keep being
  billed at cached-read price.
- Only the **uncached delta tail** (turns written after the last soft
  compaction) is ever replaced.

**Cadence: `auto` (default) — repeated.** Providers cache on the exact
serialized prefix: Anthropic hashes the prefix up to the cache breakpoint
("the system computes the prefix hash at your breakpoint and checks for a
matching cache entry... walking backward one block at a time"); DeepSeek
matches *independent prefix units* only on an exact full match. So
rewriting an already-cached span resets the cache from there. The original
`once` cadence compacted exactly once and then latched, but that only
bounded the context once: as the session grew back, pi's own built-in
threshold/overflow compaction eventually fired — an LLM summarizer call and
a full-prefix re-write (cache nuked), repeating on every later crossing.
The repeated cadence re-arms at every crossing instead: trigger
(`agent_settled`, i.e. immediately after that turn's output) at each settle
where `getContextUsage().tokens` has reached `PI_CACHE_SOFT_MIN_TOKENS`
(default 20000 ≈ pi's `keepRecentTokens`) since the last compaction — the
first moment older turns would be swept into summarized history, so every
sweep lands *right before becoming history*. Each pass replaces the newest
uncached delta with the SAME stub at pi's own cut point; the
`[stable head][stub][recent window]` head is byte-identical across all
compactions and stays cache-warm, while input stays bounded near
2x `keepRecentTokens` forever. Natural hysteresis prevents churn: a
compaction drops live context far below the threshold, and the
min-delta-turns gate must elapse — so the trigger cannot loop within a turn and only re-fires after
real growth. (DeepSeek additionally persists *common prefixes* across
requests as their own cache prefix units, so the repeated-stub head is
exactly the shape that stays cached there.) `PI_CACHE_SOFT_COMPACT=off`
disables this feature.

**Mechanism (uses pi's extension-visible compaction machinery):**
1. On cadence (`agent_settled`, re-armed in mode `auto`), call
   `ctx.compact()`. agent_settled is the guaranteed-idle point right after
   a turn's output; no hidden continuation is injected — the next user
   message simply re-runs the agent on the compacted context.
2. Our `session_before_compact` handler returns a custom proposal ONLY
   when WE triggered it (built-in threshold/overflow compactions pass
   through untouched). The proposal is
   `{ summary: FAST_COMPACTION_STUB, firstKeptEntryId: <pi's own cut>,
   tokensBefore }` — a fixed, byte-stable stub in place of the uncached
   delta, with pi's recent window kept verbatim. No model call, no
   `messagesToSummarize` read-back; O(1). The stub is a byte constant
   (`FAST_COMPACTION_STUB`): changing it would shift every following byte
   and invalidate the cached prefix, so it is part of the cache contract.
   (The model-backed smart path behind `PI_CACHE_SOFT_FAST=0` was
   removed — it was never wired and had no surviving configuration.)

**Economics.** Without it, every long-context turn re-sends (and re-reads)
all history at read price (or full price where reads are unbilled); with a
single compaction, history is compressed once but then grows back toward
pi's own cold threshold compaction — an LLM summarizer call plus a
full-prefix re-write at full input price, repeating at every later
crossing. The repeated cadence compresses every crossing instead: the
dropped span was uncached anyway, the bounded `[stable head][stub][recent
window]` request is almost entirely cache reads (Anthropic 0.1x; DeepSeek
0.1x native), and the summarizer never runs. The one re-write cost per
pass: after a compaction the kept window's bytes sit at a new position, so
the next request re-writes them once (Anthropic's walk-back finds prior
writes up to the stub; DeepSeek's common-prefix persistence re-arms the
head unit); after that the window is warm again until the next crossing.
Web evidence (fetched 2026-09-18): Anthropic — "Because the hash is
cumulative, covering everything up to and including the breakpoint,
changing any block at or before the breakpoint produces a different hash
on the next request"; DeepSeek — "Each cached prefix is an independent,
complete unit. A subsequent request can only hit the cache if it fully
matches a cache prefix unit", plus "Common prefix detection persistence".
Full verbatim quotes and URLs:
`docs/research/internet-prompt-caching-2026-09-18.md`.

**Guardrails.** Same as auto-compact: fire at `agent_settled`, never
during streaming/overflow, opt-in env `PI_CACHE_SOFT_COMPACT` (`off` |
`auto` = repeated, default; legacy `once` accepted as an alias), min turns
since the last compaction `PI_CACHE_SOFT_MIN_DELTA_TURNS` (default 1),
re-arm token gate `PI_CACHE_SOFT_MIN_TOKENS` (default 20000 ≈ pi's
`keepRecentTokens`; legacy `PI_CACHE_ONCE_MIN_TOKENS` accepted), the
already-compacted-span invariant enforced via pi's cut. One platform constraint: pi's TUI renders its own compaction
indicator and summary row unconditionally (pi 0.85.1: `interactive-mode.js`
`compaction_start`/`compaction_end` handlers, no silent option in
`CompactionPreparation`/`SessionBeforeCompactResult`/`CompactionSettings`);
only the cost line is gated, by the `showCacheMissNotices` user setting
(default off). The extension therefore cannot hide those core rows.

**Telemetry visibility.** `session_compact` records entry id, tokens and
`fromExtension`; ledger rows already capture every request incl. the
summarizer; `/cache-stats` gains a `compactions: N` counter. Context-window
telemetry stays honest: `getContextUsage()` reflects the compacted context
per pi's
own gates.

**Compaction artifact store.** Each soft pass that fires our proposal
(proposal stashed only when our session_before_compact listener consumed
the trigger — built-in compactions are never captured) derives the
compacted-out span from `event.branchEntries` at proposal time and, on a
successful `session_compact`, writes it verbatim (full entry JSON —
tool_use arguments, thinking signatures, base64 images, and tool_result
text blocks that carry subagent output) to a temporary store under
`~/tmp/pi-cache/compacts`. Schema: JSONL with a header record, one
`entry` line per dropped message (whole SessionEntry JSON, verbatim), a
`compaction-ref` line pointing at the previous stub by id + constant
(the stub text is never duplicated), and a `footer` (or an `overflow`
record when a 16 MiB per-artifact cap is hit); a `LATEST` pointer at the
store root and per session names the newest artifact, and the
`pi-cache-compaction` entry surfaces both paths. Access channel is that
fixed well-known `LATEST` because appendEntry is out of LLM context: the
agent or user reads the file to recover what was compacted. GC is strict
and confined to the owned root: a per-session ring of 3 artifacts, a
global cap of 200, a 7-day TTL, pruned after each write and at session
start, factory load, and shutdown; a realpath ownership guard ensures it
can never delete a file outside the store.

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