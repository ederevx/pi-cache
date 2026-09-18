/**
 * pi-cache — compaction advisor.
 *
 * One responsibility: decide whether a pending compaction is worth a
 * cache-related advisory. Purely observational — it never cancels or
 * alters compaction (an overflow recovery must never be wedged; house
 * rule from manual-only cancel is the established pattern). Decisions
 * are computed from the ledger's session totals plus the preparation
 * sizes passed in by the hook.
 */

export interface CompactionAdvisorOptions {
  enabled: boolean;
  warmRatioThreshold: number;
  advisoryMinTokens: number;
}

export interface LedgerTotals {
  n: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export class CompactionAdvisor {
  constructor(private readonly opts: CompactionAdvisorOptions) {}

  /**
   * One advisory string when a warm-cache session is about to re-write a
   * large prefix; undefined when there is nothing useful to say.
   */
  suggest(totals: LedgerTotals, entryCount: number, tokensBefore: number): string | undefined {
    if (!this.opts.enabled) return undefined;
    if (totals.n === 0) return undefined;
    const denom = totals.input + totals.cacheRead;
    if (denom <= 0) return undefined;
    const ratio = totals.cacheRead / denom;
    if (ratio >= this.opts.warmRatioThreshold && tokensBefore >= this.opts.advisoryMinTokens) {
      return (
        `pi-cache: warm cache (${(ratio * 100).toFixed(0)}%) with ${entryCount} ` +
        `entries ahead of compaction; consider raising keepRecentTokens to ` +
        `avoid a full prefix re-write`
      );
    }
    return undefined;
  }
}