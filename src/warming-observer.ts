/**
 * pi-cache — cache-warming observer.
 *
 * One responsibility: remember when pi last actually refreshed the provider
 * cache (`cache_warming_decision` with a "warm" action). pi's warmer can
 * keep a prompt-cache entry alive past its nominal TTL, so the idle TTL
 * trigger must measure from the last real cache touch, not only the last
 * turn, or it would compact a cache pi just rewarmed.
 */

export type WarmingAction = "warm" | "stop";

export class WarmingObserver {
  private lastWarmAt: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Record pi's (or another extension's) warming decision for one refresh.
   *  The decision fires before the refresh, so a rejected warm still resets
   *  the age; that is conservative and only delays idle compaction. */
  note(action: WarmingAction | undefined): void {
    if (action === "warm") this.lastWarmAt = this.now();
  }

  /** Milliseconds since the last warm refresh, or undefined if none yet. */
  msSinceLastWarm(): number | undefined {
    if (this.lastWarmAt === undefined) return undefined;
    return Math.max(0, this.now() - this.lastWarmAt);
  }
}