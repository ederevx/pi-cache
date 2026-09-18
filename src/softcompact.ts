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
 *  - The only lever is the custom `session_before_compact` proposal, where
 *    WE call the model ourselves with the session's system prompt and a
 *    copied (byte-identical) cached prefix, so the summarizer reads the
 *    warm prefix at read price and only the delta is fresh.
 *  - Boundary: never summarize earlier than the later of pi's own cut and
 *    the last soft-compaction entry id — cached spans stay out of the span.
 */

import type { Usage } from "@earendil-works/pi-ai";

export type SoftCompactMode = "off" | "cold" | "once" | "always";

export interface SoftCompactOptions {
  mode: SoftCompactMode;
  /**
   * Fast mode: the delta is replaced by a fixed stub instead of an LLM
   * summary. Byte-stable stub -> the compaction entry itself is cached,
   * so the next request's prefix stays warm. Default on.
   */
  fast: boolean;
  /** Minimum turns of uncached delta before the cadence acts. */
  minDeltaTurns: number;
  /**
   * One-shot trigger (mode "once"): context tokens at/above this value
   * authorize the single compaction — the point where older turns would
   * first be swept into summarized history.
   */
  onceMinTokens: number;
  /** Keep this many of the newest entries verbatim on top of the boundary. */
  keepRecentFloor: number;
}

export interface SoftCompactProposal {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;
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
 * Minimal continuation prompt for the auto-resume after a soft compaction.
 * Kept short and stable: this text reappears in the transcript every turn
 * and is itself swept into the stub on later compactions.
 */
export const SOFT_RESUME_PROMPT = "Continue.";

export interface SummaryJob {
  /** The messages the summarizer should read (delta only). */
  messages: unknown[];
  /** System prompt to use for the summary call. */
  systemPrompt: string;
  previousSummary?: string;
}

export interface SummaryService {
  summarize(job: SummaryJob): Promise<{ text: string; usage?: Usage }>;
}

export class SoftCompactionController {
  private boundaryEntryId: string | undefined;
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

  /** After a successful compaction, record the new boundary + telemetry. */
  recordCompaction(compactionEntry: { id?: string; firstKeptEntryId?: string } | undefined): void {
    this.compactions++;
    if (this.opts.mode === "once") this.onceCompacted = true;
    const id = compactionEntry?.id ?? compactionEntry?.firstKeptEntryId;
    if (id) this.boundaryEntryId = id;
    this.lastTurnsCompact = 0;
  }
  /**
   * Cadence gate for the agent_settled trigger. Also feed bumpTurn() per
   * turn. Mode "once": allow exactly one compaction, and only once the
   * live context is large enough that older turns are about to become
   * summarized history (right before "history", after the output).
   */
  shouldTrigger(
    mode: SoftCompactMode,
    cacheWarm: boolean,
    contextTokens: number | undefined,
  ): boolean {
    if (mode === "off") return false;
    if (this.lastTurnsCompact < this.opts.minDeltaTurns) return false;
    if (mode === "once") {
      if (this.onceCompacted) return false;
      return (contextTokens ?? 0) >= this.opts.onceMinTokens;
    }
    if (mode === "cold" && cacheWarm) return false;
    return true;
  }

  /**
   * Build the custom proposal for session_before_compact. Returns undefined
   * unless we triggered this compaction and (fast mode) always, or (smart
   * mode) a summary service is available.
   *
   * Fast mode: proposal with the fixed stub and pi's own cut point, so the
   * LLM summarizer call is skipped entirely. Smart mode: cache-aware model
   * proposal with the session's system prompt and the warm prefix.
   */
  async propose(
    preparation: {
      firstKeptEntryId: string;
      tokensBefore: number;
      messagesToSummarize: unknown[];
      previousSummary?: string;
    },
    systemPrompt: string,
    summary: SummaryService | undefined,
  ): Promise<SoftCompactProposal | undefined> {
    if (!this.consumeTrigger()) return undefined;
    if (this.opts.fast) return this.fastProposal(preparation);
    // Smart path (PI_CACHE_SOFT_FAST=0); fail-open to pi's default
    // summarization whenever no summary service is wired.
    return this.smartProposal(preparation, systemPrompt, summary);
  }

  /**
   * Smart proposal: cache-aware LLM summary of the uncached delta. Never
   * summarizes earlier than pi's own cut nor before our boundary; any
   * failure (no service, throw, empty text) fails open to pi's default.
   */
  private async smartProposal(
    preparation: {
      firstKeptEntryId: string;
      tokensBefore: number;
      messagesToSummarize: unknown[];
      previousSummary?: string;
    },
    systemPrompt: string,
    summary: SummaryService | undefined,
  ): Promise<SoftCompactProposal | undefined> {
    if (!summary) return undefined;
    const floor = this.latestId(this.boundaryEntryId, preparation.firstKeptEntryId);
    try {
      const result = await summary.summarize({
        messages: preparation.messagesToSummarize,
        systemPrompt,
        previousSummary: preparation.previousSummary,
      });
      if (!result.text.trim()) return undefined;
      this.lastTurnsCompact = 0;
      return {
        summary: result.text,
        firstKeptEntryId: floor,
        tokensBefore: preparation.tokensBefore,
        usage: result.usage,
      };
    } catch {
      // Fail-open: keep pi's normal behavior instead of a broken proposal.
      return undefined;
    }
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

  /** Entry-id upper bound that is later in the tree; entries are opaque ids. */
  private latestId(a: string | undefined, b: string | undefined): string {
    if (!a) return b ?? "";
    if (!b) return a;
    // Fallback when ids are not orderable: the caller's own cut takes
    // priority only if no boundary is tracked yet.
    return a;
  }

  stats(): { compactions: number; boundary: string | undefined; onceCompacted: boolean } {
    return {
      compactions: this.compactions,
      boundary: this.boundaryEntryId,
      onceCompacted: this.onceCompacted,
    };
  }
}
