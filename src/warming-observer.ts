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

/** Construction options: the clock seam and the confirm sink. */
export interface WarmingObserverOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Invoked once per newly confirmed `cache_warm` entry (dedup by
   *  entry id), with the entry for telemetry. */
  onConfirm?: (entry: WarmUsageEntry) => void;
}

/** A session entry, narrowed to the fields a warm refresh is detected
 *  and recorded by. */
export interface WarmUsageEntry {
  type?: string;
  id?: string;
  kind?: string;
  timestamp?: string;
  /** pi-ai usage of the refresh request (a full-prefix cache read). */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
  model?: string;
  provider?: string;
}

/** The context slice needed to read the session's persisted entries. */
export interface WarmSessionView {
  sessionManager?: { getEntries?: () => readonly WarmUsageEntry[] } | undefined;
}

export class WarmingObserver {
  private decisionAt: number | undefined;
  private confirmedAt: number | undefined;
  private lastWarmEntryId: string | undefined;
  private readonly now: () => number;
  private readonly onConfirm: ((entry: WarmUsageEntry) => void) | undefined;

  constructor(options: WarmingObserverOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onConfirm = options.onConfirm;
  }

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
      // The entry may carry the refresh's usage: hand it to telemetry
      // exactly once per landing. A sink failure must not unwind the
      // observer's own state, which is already updated.
      try {
        this.onConfirm?.(entry);
      } catch {
        /* telemetry only */
      }
      return;
    }
  }

  /** Milliseconds since the last warm refresh, or undefined if none yet. */
  msSinceLastWarm(): number | undefined {
    const last = this.latestTouch();
    return last === undefined ? undefined : Math.max(0, this.now() - last);
  }

  /** Milliseconds since the newest warm decision intent, or undefined
   *  when none was observed yet (confirmation-only observers). */
  msSinceDecision(): number | undefined {
    return this.decisionAt === undefined ? undefined : Math.max(0, this.now() - this.decisionAt);
  }

  /** The most recent intent-or-confirmed cache touch, if any. */
  private latestTouch(): number | undefined {
    if (this.confirmedAt === undefined) return this.decisionAt;
    if (this.decisionAt === undefined) return this.confirmedAt;
    return Math.max(this.confirmedAt, this.decisionAt);
  }
}