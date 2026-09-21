/**
 * pi-cache — cache-warming observer.
 *
 * One responsibility: remember when pi last touched the provider cache.
 * Two signals feed it: pi's `cache_warming_decision` (intent, fired before
 * the refresh is sent) and the persisted `cache_warm` usage entries (proof
 * the refresh actually landed). The idle TTL trigger measures from the most
 * recent of the two, so it never compacts a cache pi just rewarmed while an
 * unconfirmed warm decision still counts conservatively.
 */

export type WarmingAction = "warm" | "stop";

/** A session entry, narrowed to the fields a warm refresh is detected by. */
export interface WarmUsageEntry {
  type?: string;
  id?: string;
  kind?: string;
  timestamp?: string;
}

/** The context slice needed to read the session's persisted entries. */
export interface WarmSessionView {
  sessionManager?: { getEntries?: () => readonly WarmUsageEntry[] } | undefined;
}

export class WarmingObserver {
  private decisionAt: number | undefined;
  private confirmedAt: number | undefined;
  private lastWarmEntryId: string | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Record pi's warming decision (or another extension's override). The
   * decision fires before the refresh, so it is only the intent; call
   * `reconcile` to confirm the refresh actually landed.
   */
  noteDecision(action: WarmingAction | undefined): void {
    if (action === "warm") this.decisionAt = this.now();
  }

  /**
   * Reconcile with the session's persisted usage entries. The newest
   * `cache_warm` entry proves a refresh landed; entries are append-ordered,
   * so the last match wins across every branch (provider caches are keyed
   * by content, not by branch). Dedupes by entry id so repeated calls are
   * idempotent, and seeds from the existing tail on the first call so a
   * resumed session does not re-count an old warm.
   */
  reconcile(session: WarmSessionView | undefined): void {
    const entries = session?.sessionManager?.getEntries?.();
    if (!entries) return;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "usage" || entry.kind !== "cache_warm") continue;
      if (entry.id !== undefined && entry.id === this.lastWarmEntryId) return;
      this.lastWarmEntryId = entry.id;
      const parsed = Date.parse(entry.timestamp ?? "");
      this.confirmedAt = Number.isFinite(parsed) ? parsed : this.now();
      return;
    }
  }

  /** Milliseconds since the last warm refresh, or undefined if none yet. */
  msSinceLastWarm(): number | undefined {
    const last = this.latestTouch();
    return last === undefined ? undefined : Math.max(0, this.now() - last);
  }

  /** The most recent intent-or-confirmed cache touch, if any. */
  private latestTouch(): number | undefined {
    if (this.confirmedAt === undefined) return this.decisionAt;
    if (this.decisionAt === undefined) return this.confirmedAt;
    return Math.max(this.confirmedAt, this.decisionAt);
  }
}