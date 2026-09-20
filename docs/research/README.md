# Research evidence index

Distilled, citation-backed research for pi-cache. Provider pricing and TTLs
shift; re-verify before relying on them economically. Raw worker transcripts
are not published with this repository.

## Distilled reports

- `internet-prompt-caching-2026-09-18.md` — provider prefix-cache semantics
  (fetched docs): Anthropic cumulative breakpoint hash + 20-block walk-back;
  DeepSeek exact-match prefix units + common-prefix persistence; OpenAI
  full-prefix match; plus a cache-coldness section (2026-09-20) on TTL and
  eviction, client observability, and pi's warming model.

## Condensed key facts

**Economics: reads are 2-12x cheaper than writes; the ratio is the game.**
- Anthropic reads 0.1x; OpenAI reads 0.1x (GPT-5.6+); Gemini ~0.08x;
  DeepSeek native 0.1x [unverified] vs OpenRouter table 1.0x [verified table]
  — **conflict; telemetry must settle it for this machine's model.**
- Writes: Anthropic 1.25x (5m) / 2x (1h); OpenAI 1.25x; Bedrock ~1.25x.

**Dominant miss causes:** prefix below provider minimum; TTL expiry;
changed opening block; provider move. **Dominant client rules:** byte-stable
opening messages + stable tool schemas + append-only history.

**Rate-limit asymmetry:** Anthropic exempts cache hits from TPM; OpenAI counts
cached tokens against TPM.

## Still open for verification

- Gemini implicit-cache TTL and minimums (two sources conflict: 2,048/4,096
  token minimums from a Wayback snapshot of official docs vs unverified
  memory estimates).
- DeepSeek native cache-hit pricing multiplier.
- Aider "rolling breakpoint" cache-write-reduction (source-level unverified).
- `--cache-session-suffix` in Claude Code: NOT found in v2.1.272 binary;
  treat as apocryphal.