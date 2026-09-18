/**
 * pi-cache — soft per-turn compaction (cache-first).
 *
 * One responsibility: keep the context small and cache-favorable without
 * ever touching already-cached segments. Invariant (user spec): previous
 * soft-compaction spans are byte-stable forever — they are already cached,
 * and rewriting them invalidates the prefix.
 *
 * Mechanism (audit-verified levers):
 *  - `agent_settled` is the guaranteed-idle cadence point.
 *  - The built-in summarizer is hardcoded cold (cacheRetention:"none",
 *    fresh routing id, separate system prompt) and before_provider_request
 *    never fires for it — so `ctx.compact()` cannot make it cache-aware.
 *  - The custom `session_before_compact` proposal replaces pi's own
 *    summary call: the uncached delta is replaced by a fixed, byte-stable
 *    stub (FAST_COMPACTION_STUB) at pi's own cut point, so the compaction
 *    entry itself is cached and the next request's prefix stays warm — no
 *    LLM summarizer call at all (the model-backed smart path was removed:
 *    it was never wired and had no surviving configuration).
 *
 * Cadence (mode "auto", default): REPEATED. The trigger re-arms every
 * time the live context grows back to the threshold after the previous
 * compaction (natural hysteresis: compaction drops context far below the
 * threshold, so the gate cannot re-fire the same turn). Each pass replaces
 * only the span pi's own cut marks for summarization — the newest uncached
 * delta — with the SAME byte-stable stub, so the [stable head][stub]
 * prefix of every request stays byte-identical across all compactions and
 * keeps hitting the provider cache; the span that is dropped was uncached
 * anyway. Input stays bounded near 2x keepRecentTokens instead of growing
 * to pi's own cold threshold compaction (LLM summarizer + full-prefix
 * re-write, cache nuked).
 */

export type SoftCompactMode = "off" | "auto";

export interface SoftCompactOptions {
  mode: SoftCompactMode;
  /** Minimum turns since the last compaction before the cadence acts. */
  minDeltaTurns: number;
  /**
   * Re-arm threshold (mode "auto"): when live context tokens reach this
   * value again after the previous compaction, authorize another fast
   * compaction — the point where older turns would first be swept into
   * summarized history.
   */
  minTokens: number;
}

export interface SoftCompactProposal {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

/**
 * Fixed, byte-stable stub that replaces the uncached delta in fast mode.
 * A literal constant: any change here would shift every following byte and
 * invalidate the whole cached prefix, so this text is part of the cache
 * contract and must only ever change with a deliberate cache reset.
 */
export const FAST_COMPACTION_STUB =
  "Earlier conversation turns were fast-compacted by pi-cache (cache-first " +
  "soft compaction). The working context is in the turns below.";

export class SoftCompactionController {
  private pendingTrigger = false;
  private lastTurnsCompact = 0;
  private compactions = 0;

  constructor(private readonly opts: SoftCompactOptions) {}

  /** Set when we called ctx.compact() ourselves; cleared by the core flow. */
  markTriggered(): void {
    this.pendingTrigger = true;
  }

  /** Per-turn cadence bookkeeping (call from turn_end). */
  bumpTurn(): void {
    this.lastTurnsCompact++;
  }

  /** Clear the "we triggered" flag; called at the end of our proposal path. */
  consumeTrigger(): boolean {
    const was = this.pendingTrigger;
    this.pendingTrigger = false;
    return was;
  }

  /** Peek without consuming: the handler guard must not eat the flag. */
  isTriggered(): boolean {
    return this.pendingTrigger;
  }

  /**
   * Release an armed trigger without consuming it as a proposal. Used when
   * the compact() call itself failed before the hook ran, so a later
   * user-initiated compaction is never overridden by a stale flag.
   */
  clearTrigger(): void {
    this.pendingTrigger = false;
  }

  /** After a successful compaction, record telemetry. */
  recordCompaction(): void {
    this.compactions++;
    this.lastTurnsCompact = 0;
  }
  /**
   * Cadence gate for the agent_settled trigger. Also feed bumpTurn() per
   * turn. Mode "auto": re-arm every time the live context has grown back
   * to the threshold since the last compaction (natural hysteresis: the
   * compaction just dropped context below it, and the min-delta-turns gate
   * must elapse, so the gate cannot re-fire within a turn). Each pass only
   * replaces the newest uncached delta with the same byte-stable stub, so
   * the cached head never moves.
   */
  shouldTrigger(mode: SoftCompactMode, contextTokens: number | undefined): boolean {
    if (mode === "off") return false;
    if (this.lastTurnsCompact < this.opts.minDeltaTurns) return false;
    return (contextTokens ?? 0) >= this.opts.minTokens;
  }

  /**
   * Build the custom proposal for session_before_compact. Returns undefined
   * unless we triggered this compaction. The proposal replaces pi's own
   * summary call with the fixed stub at pi's own cut point, so the LLM
   * summarizer call is skipped entirely.
   */
  async propose(preparation: {
    firstKeptEntryId: string;
    tokensBefore: number;
  }): Promise<SoftCompactProposal | undefined> {
    if (!this.consumeTrigger()) return undefined;
    return this.fastProposal(preparation);
  }

  /**
   * Fast proposal: replace exactly pi's chosen uncached span with the fixed
   * stub, keeping pi's cut point (the recent window) verbatim. No model call,
   * no messagesToSummarize read-back; O(1).
   */
  private fastProposal(preparation: {
    firstKeptEntryId: string;
    tokensBefore: number;
  }): SoftCompactProposal {
    this.lastTurnsCompact = 0;
    return {
      summary: FAST_COMPACTION_STUB,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    };
  }

  stats(): { compactions: number } {
    return { compactions: this.compactions };
  }
}
