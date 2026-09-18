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
 */

export type SoftCompactMode = "off" | "once";

export interface SoftCompactOptions {
  mode: SoftCompactMode;
  /** Minimum turns of uncached delta before the cadence acts. */
  minDeltaTurns: number;
  /**
   * One-shot trigger (mode "once"): context tokens at/above this value
   * authorize the single compaction — the point where older turns would
   * first be swept into summarized history.
   */
  onceMinTokens: number;
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

/**
 * Auto-resume prompt for the hidden continuation after a soft compaction.
 * Informs the agent that the fast compaction fired and instructs it to
 * keep any pending work going; when nothing is pending it repeats its
 * last message so the continuation turn still emits an output. Kept
 * short and stable: this text reappears in the transcript every turn
 * and is itself swept into the stub on later compactions.
 */
export const SOFT_RESUME_PROMPT =
  "pi-cache: fast compaction triggered, earlier turns are now a stub. " +
  "Continue any pending work; if none, just repeat your last message.";

export class SoftCompactionController {
  private pendingTrigger = false;
  private lastTurnsCompact = 0;
  private compactions = 0;
  /** Auto-resume guard: skip the next settle (the continuation run). */
  private skipNextSettle = false;
  /**
   * Hard latch for mode "once": after the single compaction (or any
   * compaction recorded by pi), pi-cache never triggers compaction again.
   * The compacted span stays byte-identical forever — never re-summarized,
   * boundary never moved — so the provider prefix stays warm.
   */
  private onceCompacted = false;

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

  /**
   * Auto-resume bookkeeping. Called right before the continuation prompt is
   * injected; the continuation run's own settle must not re-compact, which
   * keeps the cadence at exactly one compaction per real user message.
   */
  markResumed(): void {
    this.skipNextSettle = true;
  }

  /** Consume the auto-resume skip (called at the next agent_settled). */
  consumeSkipNextSettle(): boolean {
    const was = this.skipNextSettle;
    this.skipNextSettle = false;
    return was;
  }

  /**
   * Auto-resume injection failed: release the skip guard so the next real
   * user message still compacts normally.
   */
  clearResumed(): void {
    this.skipNextSettle = false;
  }

  /** After a successful compaction, record telemetry. */
  recordCompaction(): void {
    this.compactions++;
    if (this.opts.mode === "once") this.onceCompacted = true;
    this.lastTurnsCompact = 0;
  }
  /**
   * Cadence gate for the agent_settled trigger. Also feed bumpTurn() per
   * turn. Mode "once": allow exactly one compaction, and only once the
   * live context is large enough that older turns are about to become
   * summarized history (right before "history", after the output).
   */
  shouldTrigger(mode: SoftCompactMode, contextTokens: number | undefined): boolean {
    if (mode === "off") return false;
    if (this.lastTurnsCompact < this.opts.minDeltaTurns) return false;
    if (this.onceCompacted) return false;
    return (contextTokens ?? 0) >= this.opts.onceMinTokens;
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

  stats(): { compactions: number; onceCompacted: boolean } {
    return {
      compactions: this.compactions,
      onceCompacted: this.onceCompacted,
    };
  }
}
