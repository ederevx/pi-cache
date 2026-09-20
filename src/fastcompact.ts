/**
 * pi-cache — fast cache-aware compaction override.
 *
 * One responsibility: when fast compaction is enabled, replace pi's
 * default LLM summarizer for ANY compaction (`manual`, `threshold`,
 * `overflow`) and for a `/tree` branch summary (`session_before_tree`)
 * with an O(1), byte-stable proposal at pi's own cut point.
 * The proposal keeps pi's recent window verbatim and substitutes the
 * summarized span with a fixed constant, so:
 *   - no summarizer model call is made (faster);
 *   - the `[stable prefix head][constant]` bytes never move between
 *     compactions, so the provider prefix cache stays warm (cache-aware).
 *
 * The override is total because pi's `session_before_compact` result type
 * carries an optional `compaction`; returning one skips the built-in
 * `_runDefaultCompaction` entirely. Anything unexpected makes `propose`
 * return `undefined`, which leaves pi's default summarization in place
 * (fail-open: compaction must never be wedged).
 */

import { FeatureSwitch } from "./feature-switch.ts";

export interface FastCompactOptions {
  enabled: boolean;
  /** Separate switch for the /tree branch-summary override. */
  branchEnabled: boolean;
}

/** The subset of `CompactionPreparation` this controller reads. */
export interface FastCompactPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
}

/**
 * The fixed, byte-stable stand-in for the summarized span. A literal
 * constant: changing it shifts every following byte and invalidates the
 * cached prefix, so this text is part of the cache contract and must only
 * change with a deliberate cache reset.
 */
export const FAST_SUMMARY_STUB =
  "Earlier conversation turns were fast-compacted by pi-cache (cache-first " +
  "fast compaction). The working context is in the turns below.";

/**
 * Fixed, byte-stable stand-in for an abandoned `/tree` branch. Kept
 * separate from the compaction stub so the two context shapes stay
 * distinguishable while each remains deterministic.
 */
export const FAST_BRANCH_STUB =
  "The abandoned branch was fast-summarized by pi-cache (cache-first fast " +
  "compaction). Continue from the selected point below.";

export class FastCompactionController {
  private readonly compaction: FeatureSwitch;
  private readonly branch: FeatureSwitch;
  private compactions = 0;

  constructor(opts: FastCompactOptions) {
    this.compaction = new FeatureSwitch(opts.enabled);
    this.branch = new FeatureSwitch(opts.branchEnabled);
  }

  /** The live compaction switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.compaction.enabled;
  }

  /** The live branch-summary switch (its own /cache-settings row). */
  get branchEnabled(): boolean {
    return this.branch.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.compaction.set(enabled);
  }

  setBranchEnabled(enabled: boolean): void {
    this.branch.set(enabled);
  }

  /**
   * The fast proposal for `session_before_compact`, or `undefined` to let
   * pi's default summarizer run. Applies to every compaction reason when
   * enabled (the "overall" override).
   */
  propose(preparation: FastCompactPreparation | undefined): {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  } | undefined {
    if (!this.compaction.enabled) return undefined;
    if (!preparation) return undefined;
    if (typeof preparation.firstKeptEntryId !== "string") return undefined;
    if (typeof preparation.tokensBefore !== "number") return undefined;
    return {
      summary: FAST_SUMMARY_STUB,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    };
  }

  /** Count a completed fast compaction for /cache-stats. */
  recordCompaction(): void {
    this.compactions++;
  }

  /**
   * The fast branch-summary proposal for `session_before_tree`, or
   * `undefined` to let pi's default summarizer run. pi only uses an
   * extension summary when the user asked for one and there are entries
   * to summarize, so mirror those guards here.
   */
  proposeBranch(
    entriesToSummarize: number,
    userWantsSummary: boolean,
  ): { summary: string } | undefined {
    if (!this.branch.enabled) return undefined;
    if (!userWantsSummary) return undefined;
    if (!(entriesToSummarize > 0)) return undefined;
    return { summary: FAST_BRANCH_STUB };
  }

  stats(): { compactions: number } {
    return { compactions: this.compactions };
  }
}
