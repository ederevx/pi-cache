/**
 * pi-cache — provider-aware cache lifetime.
 *
 * One responsibility: map the model in use onto its provider cache lifetime
 * so the coldness ramp, the idle timer, and the ledger's warm flag measure
 * against the real TTL instead of one static default. pi's own
 * `model.promptCache` tier remains the authority when it is declared; the
 * bundled catalog populates it for no provider, so a user `models.json` or a
 * `modelOverrides` entry is what usually declares it. This resolver is the
 * fallback the signals consult next. Owns no state: the profile table is
 * supplied by the caller (see constants.ts), because a provider's cache
 * lifetime is a provider fact, not a code constant.
 */

/** One profile: case-insensitive match tokens plus its short and long
 *  retention lifetimes in seconds. */
export interface TtlProfile {
  matches: readonly string[];
  short: number;
  long: number;
}

export class ModelTtl {
  constructor(private readonly profiles: readonly TtlProfile[]) {}

  /**
   * The effective short/long cache lifetime (s) for a provider + model, or
   * undefined when no profile matches so the caller's static fallback
   * (PI_CACHE_TTL_SECONDS) still owns unknown models. Ordered profiles; the
   * first matching substring of `${provider} ${modelId}` wins.
   */
  secondsFor(provider: string | undefined, modelId: string | undefined, long = false): number | undefined {
    const key = `${provider ?? ""} ${modelId ?? ""}`.toLowerCase();
    for (const profile of this.profiles) {
      if (profile.matches.some((token) => key.includes(token))) {
        return long ? profile.long : profile.short;
      }
    }
    return undefined;
  }
}
