/**
 * pi-cache — compaction gate.
 *
 * One responsibility: serialize compaction requests so at most one is in
 * flight and the same idle window is never compacted twice. A "window" is
 * the cache state since the last recorded turn; its key changes only when a
 * new turn appends a ledger row, so a completed compaction cannot be undone
 * by a second trigger in the same idle stretch.
 */

export class CompactionGate {
  private inFlight = false;
  private lastKey: string | undefined;

  /**
   * Claim a compaction window. False when one is already running (a second
   * `ctx.compact` would abort the first) or when this exact window has
   * already been compacted.
   */
  tryBegin(key: string): boolean {
    if (this.inFlight) return false;
    if (this.lastKey !== undefined && this.lastKey === key) return false;
    this.inFlight = true;
    return true;
  }

  /** Release the claim and remember the window as compacted. */
  settle(key: string): void {
    this.inFlight = false;
    this.lastKey = key;
  }

  /** Forget all state (session replacement). */
  reset(): void {
    this.inFlight = false;
    this.lastKey = undefined;
  }
}