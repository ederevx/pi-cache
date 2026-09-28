/**
 * pi-cache — midterm compaction proposal.
 *
 * One responsibility: build the boundary compaction draft that lets pi
 * apply a mid-run compaction AND continue the run, replacing the old
 * `ctx.compact()` call that aborts the live turn. The draft carries the
 * fast-compaction summary (fast compaction is what makes a mid-run rewrite
 * cache-neutral); when fast compaction is off `draft()` returns undefined
 * and the caller keeps the aborting request as a fallback.
 */

import { DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { CompactionEntryDraft } from "@earendil-works/pi-coding-agent";
import type { FastCompactionController } from "./fastcompact.ts";
import { MidtermCutPlanner } from "./midterm-cut.ts";

/** The session surface `draft()` reads (structurally typed for tests). */
export interface MidtermSession {
  buildSessionProjection?: () => { entries: unknown[]; messages: unknown[] } | undefined;
  getSessionFile?: () => string | undefined;
}

export interface MidtermContext {
  sessionManager?: MidtermSession;
}

export class MidtermCompactor {
  constructor(
    private readonly fastcompact: FastCompactionController,
    private readonly cut = new MidtermCutPlanner(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
  ) {}

  /**
   * The compaction draft and continuation request, or `undefined` when
   * there is nothing to compact or fast compaction cannot summarize it.
   */
  draft(context: MidtermContext | undefined, usageTokens?: number): CompactionEntryDraft | undefined {
    const manager = context?.sessionManager;
    const projection = manager?.buildSessionProjection?.();
    if (!projection?.entries || projection.entries.length === 0) return undefined;
    const tokensBefore = this.tokensBefore(projection.messages, usageTokens);
    const preparation = this.cut.plan(
      projection.entries as Parameters<MidtermCutPlanner["plan"]>[0],
      tokensBefore,
    );
    if (!preparation) return undefined;
    const proposal = this.fastcompact.propose(preparation, manager?.getSessionFile?.());
    if (!proposal) return undefined;
    return {
      type: "compaction",
      summary: proposal.summary,
      firstKeptEntryId: proposal.firstKeptEntryId,
    };
  }

  /** Live tokens when pi reported them, else an estimate of the projection. */
  private tokensBefore(messages: unknown[], usageTokens?: number): number {
    if (typeof usageTokens === "number" && usageTokens > 0) return usageTokens;
    let total = 0;
    for (const message of messages) {
      total += estimateTokens(message as Parameters<typeof estimateTokens>[0]);
    }
    return total;
  }
}
