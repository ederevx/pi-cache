/**
 * pi-cache — provider-aware cache lifetime.
 *
 * One responsibility: map the model in use onto its provider cache lifetime
 * so the coldness ramp, the idle timer, and the ledger's warm flag measure
 * against the real TTL instead of one static default. pi's own
 * `model.promptCache` tier remains the authority when it is declared
 * (Anthropic is the only pi catalog entry that populates it); this resolver
 * is the fallback the signals consult next. Owns only a static profile
 * table; no mutable state.
 */

/** One static profile: case-insensitive match tokens plus its short and
 *  long retention lifetimes in seconds. */
interface TtlProfile {
  matches: readonly string[];
  short: number;
  long: number;
}

export class ModelTtl {
  /**
   * Ordered profiles; the first matching substring of
   * `${provider} ${modelId}` wins. Values are the documented provider
   * lifetimes (see docs/research/internet-prompt-caching-2026-09-18.md):
   * Anthropic/OpenAI/Kimi/Gemini are published, DeepSeek and GLM are
   * conservative empirical midpoints because neither publishes a lifetime.
   */
  private static readonly PROFILES: readonly TtlProfile[] = [
    { matches: ["anthropic"], short: 300, long: 3600 },
    { matches: ["openai", "azure"], short: 1800, long: 1800 },
    { matches: ["moonshot", "kimi", "qwen", "alibaba"], short: 300, long: 3600 },
    { matches: ["deepseek"], short: 14400, long: 14400 },
    { matches: ["z-ai", "glm"], short: 120, long: 120 },
    { matches: ["google", "gemini"], short: 300, long: 3600 },
  ];

  /**
   * The effective short/long cache lifetime (s) for a provider + model, or
   * undefined when no profile matches so the caller's static fallback
   * (PI_CACHE_TTL_SECONDS) still owns unknown models.
   */
  secondsFor(provider: string | undefined, modelId: string | undefined, long = false): number | undefined {
    const key = `${provider ?? ""} ${modelId ?? ""}`.toLowerCase();
    for (const profile of ModelTtl.PROFILES) {
      if (profile.matches.some((token) => key.includes(token))) {
        return long ? profile.long : profile.short;
      }
    }
    return undefined;
  }
}
