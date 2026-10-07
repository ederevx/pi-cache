/**
 * pi-cache — verbatim kept-window limiter for fast compaction.
 *
 * One responsibility: given the projected session entries and pi's chosen
 * cut point, bound the tokens a fast compaction keeps verbatim.
 *
 * pi's own `findProjectedCutPoint` walks back to roughly
 * `keepRecentTokens`, but one context-visible entry that exceeds that
 * budget by itself (a many-hundred-KB tool result) forces the cut to the
 * turn boundary BEFORE it, so the oversized entry stays in the verbatim
 * window and the post-compaction context does not actually shrink. The
 * provider then rejects the next request (input plus the completion
 * reservation exceeds the model window), the overflow retry compacts
 * again, and the same entry is kept again: an unbounded recovery loop.
 *
 * This limiter advances the cut to the next safe boundary (never an orphan
 * tool result) whose retained window fits a bounded multiple of pi's
 * keep-recent budget, and, when even the tail is one oversized entry, keeps
 * nothing so the compaction still sheds it. The dropped content is never
 * lost: it already lives in the session file the fast summary points at.
 */

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

/** The cut the fast-compaction proposal should use for its kept window. */
export interface KeptWindowPlan {
  firstKeptEntryId: string;
  /** Messages between pi's cut and the bounded cut, additionally dropped. */
  extraDropped: readonly unknown[];
}

export class KeptWindowLimiter {
  /**
   * Kept window that cannot be trusted (the single-entry tail itself is
   * oversized). It matches no session entry, so pi keeps only the summary.
   */
  static readonly KEEP_NONE = "pi-cache-keep-none";

  /** Retained-window cap as a multiple of pi's `keepRecentTokens`. */
  private readonly ratio: number;

  constructor(ratio: number) {
    this.ratio = ratio;
  }

  /**
   * Bound the verbatim window. Returns pi's cut unchanged when the entries
   * are unavailable, the cut is not on the path, or the window already
   * fits the cap.
   */
  limit(
    entries: readonly ProjectedSessionEntry[] | undefined,
    firstKeptEntryId: string,
    keepRecentTokens: number,
  ): KeptWindowPlan {
    const unchanged: KeptWindowPlan = { firstKeptEntryId, extraDropped: [] };
    if (!entries || entries.length === 0) return unchanged;
    const start = entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
    if (start < 0) return unchanged;
    const cap = this.cap(keepRecentTokens);
    if (cap <= 0 || this.retained(entries, start) <= cap) return unchanged;
    for (let i = start + 1; i < entries.length; i++) {
      if (!this.canStartAt(entries[i])) continue;
      if (this.retained(entries, i) <= cap) {
        return {
          firstKeptEntryId: entries[i].sourceEntry.id,
          extraDropped: this.between(entries, start, i),
        };
      }
    }
    // No boundary fits: the tail itself is one oversized entry. Keep only
    // the summary so the compaction still sheds it.
    return {
      firstKeptEntryId: KeptWindowLimiter.KEEP_NONE,
      extraDropped: this.between(entries, start, entries.length),
    };
  }

  /** The retained-window cap in tokens; 0 when the budget is unusable. */
  private cap(keepRecentTokens: number): number {
    if (!Number.isFinite(keepRecentTokens) || keepRecentTokens <= 0) return 0;
    return keepRecentTokens * this.ratio;
  }

  /** Estimated tokens kept verbatim from entry `start` to the end. */
  private retained(entries: readonly ProjectedSessionEntry[], start: number): number {
    let tokens = 0;
    for (let i = start; i < entries.length; i++) {
      for (const message of entries[i].messages) {
        tokens += estimateTokens(message);
      }
    }
    return tokens;
  }

  /** A window may start anywhere except on an orphaned tool result. */
  private canStartAt(entry: ProjectedSessionEntry): boolean {
    return entry.messages[0]?.role !== "toolResult";
  }

  /** Non-system messages dropped by advancing the cut from `start` to `end`. */
  private between(
    entries: readonly ProjectedSessionEntry[],
    start: number,
    end: number,
  ): unknown[] {
    const dropped: unknown[] = [];
    for (let i = start; i < end; i++) {
      for (const message of entries[i].messages) {
        if (message.role !== "system") dropped.push(message);
      }
    }
    return dropped;
  }
}
