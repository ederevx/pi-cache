# Research evidence index

Everything in `raw/` was produced for this project by research workers
(2026-09-17/18). Files are distilled transcripts of the workers' final
reports; treat all numbers as dated (provider pricing/TTLs shift) and
re-verify before relying on them economically.

## Raw reports

| File | Topic | Highlights |
|---|---|---|
| `provider documentation` | Provider mechanics (round 1) | Anthropic 5m/1h TTL + 1.25x/2x write, 0.1x read; OpenAI 1,024 min, 30m TTL, 1.25x/0.1x; Gemini implicit; OpenRouter passthrough matrix; usage fields per API |
| `provider documentation` | pi extension feasibility | Extension API surfaces, interception points, per-candidate feasibility (a-e), MVP design, blockers |
| `provider documentation` | Gateways / OpenRouter corrections | "middle-out transformers"/"byte-level caching" blog posts do not exist (verified against 124-post RSS feed); real post = "Prompt Caching + Sticky Routing"; sticky-routing identity hash; DeepSeek 1.0x read on OR table; LiteLLM/Portkey/Helicone/Cloudflare/one-api posture |
| `provider documentation` | Agent frameworks | Claude Code binary-mined (skipCacheWrite, forkPointPinned, cacheScope, cacheBreakerPhrase, /costs metering bug #94224, #94197 compaction cost); aider (#5556 cache-key pollution, keepalive pings); opencode #14743 (0% -> 97.6% via S1/S2 split); Anthropic context editing (clear_at_least, server-side clearing) |
| `provider documentation` | Direct providers (fetched docs) | Anthropic 4 breakpoints + top-level auto, min 512-4,096 by model, org/workspace cache keys, TPM exemption; OpenAI unified guide (explicit breakpoints, 4 writes, 50 lookups, 128-rounding, 15 rpm machine locality, TPM counting); Bedrock cachePoint 5m/1h, 4 checkpoints, usage fields |
| `public web sources` | Web sweep | GitHub cache-injection proxies; pi-better-messages-cache deprecation precedent; aider rolling breakpoint + keepalive source-confirmed; corrected citation URLs |
| `raw/provider documentation.md` | pi implementation reference | ExtensionAPI shapes, Usage, pi-ai cache internals (file:line), compaction contract, gaps/workarounds |
| `provider documentation` | Extension structure audit | House layout/style/OOP spec for pi-cache (index.ts wire-only, no module globals, env-var config idiom, appendEntry, dot-dirs) |
| `the pi request serialization audit` | pi request-serialization audit | Wire bytes are already deterministic per (session, conversation, toolset); cwd + readdir-ordered skills are the only per-machine prefix churn; safe/risky before_provider_request transforms per API; cache_control pinned to last tool |
| `provider prompt-caching documentation` | Semantic-preserving transforms | Determinism not canonicalism is the lever; template pinning; breakpoint layouts; TTL/retention knobs; 0→97.6% opencode precedent; illusions list |
| `internet-prompt-caching-2026-09-18.md` | Provider prefix-cache semantics (fetched docs) | Verbatim quotes: Anthropic cumulative breakpoint hash + 20-block walk-back; DeepSeek exact-match prefix units + common-prefix persistence; OpenAI full-prefix match, 1024 min; context-engineering compaction guidance; plus a cache-coldness section (2026-09-20) on TTL/eviction, client observability, and pi's warming model |

## Condensed key facts

**Economics: reads are 2-12x cheaper than writes; the ratio is the game.**
- Anthropic reads 0.1x; OpenAI reads 0.1x (GPT-5.6+); Gemini ~0.08x;
  DeepSeek native 0.1x [unverified] vs OpenRouter table 1.0x [verified table] —
  **conflict; telemetry must settle it for this machine's model.**
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