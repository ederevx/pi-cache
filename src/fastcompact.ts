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
import { SpanDigest, type SpanFileOps } from "./digest.ts";

export interface FastCompactOptions {
  enabled: boolean;
  /** Separate switch for the /tree branch-summary override. */
  branchEnabled: boolean;
  /** Append a deterministic digest of the dropped span after the stub. */
  digestEnabled: boolean;
  /** Dropped-span token estimate at/above which pi's LLM summarizer runs. */
  digestMaxSpanTokens: number;
}

/** The subset of `CompactionPreparation` this controller reads. */
export interface FastCompactPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  /** Messages pi will discard (summarized span). */
  messagesToSummarize?: readonly unknown[];
  /** Messages of a split turn's prefix, when pi cuts mid-turn. */
  turnPrefixMessages?: readonly unknown[];
  /** True when pi's cut point lands inside a turn. */
  isSplitTurn?: boolean;
  /** The previous compaction's summary text, when one projects. */
  previousSummary?: string;
  /** File operations pi extracted from the dropped span. */
  fileOps?: SpanFileOps;
}

/** ~4 chars/token heuristic for the dropped-span size gate. */
const CHARS_PER_TOKEN = 4;

/** Maximum message content parts walked per message in the size estimate. */
const MAX_CONTENT_PARTS = 64;

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
  private readonly digest: FeatureSwitch;
  private readonly digestMaxSpanTokens: number;
  private readonly spanDigest: SpanDigest;
  private compactions = 0;

  constructor(opts: FastCompactOptions) {
    this.compaction = new FeatureSwitch(opts.enabled);
    this.branch = new FeatureSwitch(opts.branchEnabled);
    this.digest = new FeatureSwitch(opts.digestEnabled);
    this.digestMaxSpanTokens = opts.digestMaxSpanTokens;
    this.spanDigest = new SpanDigest();
  }

  /** The live compaction switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.compaction.enabled;
  }

  /** The live dropped-span digest switch (toggled from /cache-settings). */
  get digestEnabled(): boolean {
    return this.digest.enabled;
  }

  /** Turn the digest on or off in place. */
  setDigestEnabled(enabled: boolean): void {
    this.digest.set(enabled);
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
    if (this.digest.enabled && this.spanTooLarge(preparation)) return undefined;
    return {
      summary: this.fastSummary(preparation),
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    };
  }

  /**
   * The fast summary: the constant stub, optionally followed by the
   * accumulated digest region. The stub comes first so the shared
   * prefix head is byte-identical whether or not a digest follows
   * (cache-neutral); the digest preserves the dropped span's file and
   * turn record and folds the previous compaction's digest blocks in.
   */
  private fastSummary(preparation: FastCompactPreparation): string {
    if (!this.digest.enabled) return FAST_SUMMARY_STUB;
    try {
      const block = this.spanDigest.build(
        preparation.messagesToSummarize ?? [],
        preparation.isSplitTurn ? (preparation.turnPrefixMessages ?? []) : [],
        preparation.fileOps,
      );
      const region = this.spanDigest.compose(preparation.previousSummary, block);
      if (region.length === 0) return FAST_SUMMARY_STUB;
      return `${FAST_SUMMARY_STUB}\n\n${region}`;
    } catch {
      // Digest failure must never wedge compaction: degrade to the stub.
      return FAST_SUMMARY_STUB;
    }
  }

  /**
   * Whether the dropped span is too large to summarize extractively:
   * past the token gate the digest's preservation value no longer
   * covers the loss, so the proposal yields to pi's LLM summarizer
   * (propose() returns undefined, fail-open).
   */
  private spanTooLarge(preparation: FastCompactPreparation): boolean {
    const messages = preparation.messagesToSummarize;
    const historyChars = Array.isArray(messages)
      ? FastCompactionController.spanChars(messages)
      : 0;
    const prefixMessages = preparation.turnPrefixMessages;
    const prefixChars =
      preparation.isSplitTurn && Array.isArray(prefixMessages)
        ? FastCompactionController.spanChars(prefixMessages)
        : 0;
    return (historyChars + prefixChars) / CHARS_PER_TOKEN > this.digestMaxSpanTokens;
  }

  /** Cheap serialized-size estimate of a message list, in characters. */
  private static spanChars(messages: readonly unknown[]): number {
    let total = 0;
    for (const message of messages) {
      const m = message as { content?: unknown; command?: unknown } | undefined;
      if (!m || typeof m !== "object") continue;
      const content = m.content;
      if (typeof content === "string") {
        total += content.length;
      } else if (Array.isArray(content)) {
        let parts = 0;
        for (const part of content) {
          if (parts++ >= MAX_CONTENT_PARTS) break;
          const block = part as { text?: unknown; data?: unknown } | undefined;
          if (!block || typeof block !== "object") continue;
          if (typeof block.text === "string") total += block.text.length;
          else if (typeof block.data === "string") total += block.data.length;
        }
      }
      if (typeof m.command === "string") total += m.command.length;
    }
    return total;
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
