/**
 * pi-cache — midterm compaction cut planner.
 *
 * One responsibility: turn pi's live session projection into the inputs a
 * compaction summary needs (where to cut, and which messages are being
 * dropped), mirroring pi's own `prepareCompaction` using its exported
 * `findCutPoint`. The midterm trigger proposes the compaction itself
 * instead of calling `ctx.compact()`, so pi-cache must supply the cut
 * point; reusing pi's helper keeps the cut tool-call-safe (never lands on
 * a tool result) and consistent with pi's keep-recent budget.
 */

import { findCutPoint } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

/** The subset of pi's `CompactionPreparation` the summary builder reads. */
export interface MidtermPreparation {
  /** UUID of the first entry kept verbatim. */
  firstKeptEntryId: string;
  /** Messages the summary replaces. */
  messagesToSummarize: AgentMessage[];
  /** Prefix messages when the cut lands inside a turn. */
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  /** The previous compaction's summary, folded into the next one. */
  previousSummary?: string;
  /** Live context tokens before the compaction. */
  tokensBefore: number;
}

export class MidtermCutPlanner {
  constructor(private readonly keepRecentTokens: number) {}

  /** Plan a midterm cut, or `undefined` when nothing is compactable. */
  plan(
    entries: readonly ProjectedSessionEntry[],
    tokensBefore: number,
  ): MidtermPreparation | undefined {
    if (entries.length === 0) return undefined;
    const boundary = this.boundary(entries);
    const sourceEntries = entries.map((entry) => entry.sourceEntry);
    if (boundary.start >= sourceEntries.length) return undefined;
    const cut = findCutPoint(
      sourceEntries,
      boundary.start,
      sourceEntries.length,
      this.keepRecentTokens,
    );
    const firstKept = sourceEntries[cut.firstKeptEntryIndex];
    if (!firstKept?.id) return undefined;
    const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
    const messagesToSummarize = this.messages(entries, boundary.start, historyEnd);
    const turnPrefixMessages = cut.isSplitTurn
      ? this.messages(entries, cut.turnStartIndex, cut.firstKeptEntryIndex)
      : [];
    if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
      return undefined;
    }
    return {
      firstKeptEntryId: firstKept.id,
      messagesToSummarize,
      turnPrefixMessages,
      isSplitTurn: cut.isSplitTurn,
      previousSummary: boundary.previousSummary,
      tokensBefore,
    };
  }

  /**
   * Start the summary span after the newest compaction with a visible
   * summary, exactly as pi does, so a repeated compaction updates the
   * previous summary instead of re-summarizing the retained tail.
   */
  private boundary(entries: readonly ProjectedSessionEntry[]): {
    start: number;
    previousSummary?: string;
  } {
    const index = entries.findIndex(
      (entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
    );
    if (index < 0) return { start: 0 };
    const source = entries[index].sourceEntry;
    return {
      start: index + 1,
      previousSummary: source.type === "compaction" ? source.summary : undefined,
    };
  }

  /** Collect the non-system, non-compaction messages in `[start, end)`. */
  private messages(
    entries: readonly ProjectedSessionEntry[],
    start: number,
    end: number,
  ): AgentMessage[] {
    const collected: AgentMessage[] = [];
    for (let i = Math.max(0, start); i < end; i++) {
      const entry = entries[i];
      if (entry.sourceEntry.type === "compaction") continue;
      for (const message of entry.messages) {
        if (message.role !== "system") collected.push(message);
      }
    }
    return collected;
  }
}
