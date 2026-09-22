/**
 * pi-cache — retention-aware warming schedule.
 *
 * One responsibility: compute the cache-warming refresh margin from the
 * tier the wire actually used. pi's CacheWarmer schedules from
 * `options.cacheRetention` — a request-scoped field pi-ai derives from
 * pi's own env — so when pi-cache's per-request rewrite upgrades every
 * marker to the 1h/24h tier, pi still schedules a refresh at the short
 * tier: harmless extra refreshes at best, a missed deadline at worst.
 * This class mirrors pi's margin (`90% of the tier's lifetime minus a
 * 10s margin, floored at 1s) from the signals' pi-native TTL view, which
 * already follows the effective (rewritten) tier. The wire rewrites only
 * touch pi-emitted markers, so a tier that never applied is never
 * misreported; where the tiers agree, the result equals pi's schedule.
 */

import type { SessionSignals, SessionContextView } from "./signals.ts";

/** The effective tier of the last request (per-request override). */
export interface RetentionTierSource {
  /** True (long), false (short), or unknown — undefined when the
   *  per-request override never ran. */
  effectiveLong(): boolean | undefined;
}

export class WarmingSchedule {
  /** pi's refresh fires at 90% of the declared lifetime, less a 10s
   *  safety margin (CacheWarmer.refreshDelayMs). */
  private static readonly FRACTION_OF_TTL = 0.9;
  private static readonly MARGIN_MS = 10_000;
  private static readonly MIN_DELAY_MS = 1_000;

  constructor(
    private readonly signals: SessionSignals,
    private readonly tier: RetentionTierSource,
  ) {}

  /** The refresh margin (ms) for the effective tier of the last request,
   *  or undefined when pi would schedule nothing (unknown tier). */
  refreshMarginMs(ctx: SessionContextView | undefined): number | undefined {
    const ttl = this.signals.piTtlMs(ctx);
    if (typeof ttl !== "number") return undefined;
    return Math.max(WarmingSchedule.MIN_DELAY_MS, ttl * WarmingSchedule.FRACTION_OF_TTL - WarmingSchedule.MARGIN_MS);
  }

  /** True when the per-request override lengthened the tier the last
   *  request ran on, so pi's env-based schedule wakes too early. */
  get overrideActive(): boolean {
    return this.tier.effectiveLong() === true;
  }
}
