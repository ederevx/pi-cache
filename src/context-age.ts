/**
 * pi-cache — context age.
 *
 * One responsibility: measure how much *active* time the context that is
 * still live has accumulated. This is the clock the time component of the
 * degradation model reads when the advertised window is too large for
 * occupancy alone to say anything.
 *
 * Three things are deliberately not measured:
 *  - session age, which a compaction does not reset;
 *  - wall-clock time since the last compaction, because the kept tail is
 *    older than the compaction that kept it;
 *  - idle time, because time spent not generating adds no tokens and
 *    therefore no degradation.
 *
 * The measure is the sum of consecutive gaps between entry timestamps from
 * the last compaction boundary's first kept entry to the leaf, each gap
 * capped at a short interval. Timestamps alone cannot tell a slow, continuous
 * session from one that sat idle for hours: both show a long gap. The cap
 * says that a single gap never counts for more than a bounded stretch of
 * work, so a resume after lunch does not arrive as hours of accumulated
 * context. Only entry-to-entry gaps count, never the gap from the leaf to
 * "now", so a future or clock-skewed timestamp cannot inflate the result.
 * Owns no state.
 */

/** The parts of a session branch entry this measure reads. */
export interface AgeEntry {
  id: string;
  type: string;
  /** ISO timestamp; a missing or invalid one is skipped. */
  timestamp?: string;
  /** On a `compaction` entry: the first entry the compaction kept. */
  firstKeptEntryId?: string;
}

export class ContextAge {
  /** Fallback gap cap (5 min) when the configured cap is unusable. */
  static readonly DEFAULT_GAP_CAP_MS = 5 * 60 * 1000;

  /**
   * Active milliseconds in a root-to-leaf branch, or `undefined` when there
   * is no branch to measure (the caller then reads no time pressure).
   */
  activeMs(branch: readonly AgeEntry[] | undefined, gapCapMs: number): number | undefined {
    if (!Array.isArray(branch)) return undefined;
    const cap =
      Number.isFinite(gapCapMs) && gapCapMs > 0 ? gapCapMs : ContextAge.DEFAULT_GAP_CAP_MS;
    let total = 0;
    let previous: number | undefined;
    for (let index = ContextAge.startIndex(branch); index < branch.length; index += 1) {
      const at = Date.parse(branch[index]?.timestamp ?? "");
      if (!Number.isFinite(at)) continue;
      if (previous !== undefined) total += Math.min(Math.max(0, at - previous), cap);
      previous = at;
    }
    // Fewer than two usable timestamps leaves nothing to add up; the floor
    // of the degradation model still applies, so failing closed is safe.
    return total;
  }

  /**
   * The entry the measurement starts at: the last compaction's first kept
   * entry, or the compaction entry itself when that id is absent (the
   * `KEEP_NONE` sentinel, or a branch that no longer holds the kept entry).
   * No compaction means the whole branch is live.
   */
  private static startIndex(branch: readonly AgeEntry[]): number {
    let boundary = -1;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      if (branch[index]?.type === "compaction") {
        boundary = index;
        break;
      }
    }
    if (boundary < 0) return 0;
    const kept = branch[boundary]?.firstKeptEntryId;
    if (typeof kept !== "string" || kept.length === 0) return boundary;
    for (let index = 0; index < boundary; index += 1) {
      if (branch[index]?.id === kept) return index;
    }
    return boundary;
  }
}
