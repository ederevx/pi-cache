/**
 * pi-cache — fast cache-aware compaction override.
 *
 * One responsibility: when fast compaction is enabled, replace pi's
 * default LLM summarizer for ANY compaction (`manual`, `threshold`,
 * `overflow`) with an O(1), byte-stable proposal at pi's own cut point.
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

export interface FastCompactOptions {
  enabled: boolean;
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

export class FastCompactionController {
  private compactions = 0;

  constructor(private readonly opts: FastCompactOptions) {}

  /** The live switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.opts.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.opts.enabled = enabled;
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
    if (!this.opts.enabled) return undefined;
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

  stats(): { compactions: number } {
    return { compactions: this.compactions };
  }
}
