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

export type SoftCompactMode = "off" | "cold" | "always";

export interface SoftCompactOptions {
  mode: SoftCompactMode;
  /** Minimum turns of uncached delta before the every-turn cadence acts. */
  minDeltaTurns: number;
  /** Keep this many of the newest entries verbatim on top of the boundary. */
  keepRecentFloor: number;
}

export interface SoftCompactProposal {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;
}

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

  /** After a successful compaction, record the new boundary + telemetry. */
  recordCompaction(compactionEntry: { id?: string; firstKeptEntryId?: string } | undefined): void {
    this.compactions++;
    const id = compactionEntry?.id ?? compactionEntry?.firstKeptEntryId;
    if (id) this.boundaryEntryId = id;
    this.lastTurnsCompact = 0;
  }
  /** Cadence gate for the agent_settled trigger. Also feed bumpTurn() per turn. */
  shouldTrigger(mode: SoftCompactMode, cacheWarm: boolean): boolean {
    if (mode === "off") return false;
    if (this.lastTurnsCompact < this.opts.minDeltaTurns) return false;
    if (mode === "cold" && cacheWarm) return false;
    return true;
  }

  /**
   * Build the custom proposal for session_before_compact. Returns undefined
   * unless we triggered this compaction and a summary service is available.
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
    if (!summary) return undefined;

    // Never summarize earlier than pi's own cut; never before our boundary.
    const floor = this.latestId(this.boundaryEntryId, preparation.firstKeptEntryId);
    const messages = preparation.messagesToSummarize;
    let text = "";
    let usage: Usage | undefined;
    try {
      const result = await summary.summarize({
        messages,
        systemPrompt,
        previousSummary: preparation.previousSummary,
      });
      text = result.text;
      usage = result.usage;
    } catch (error) {
      // Fail-open: keep pi's normal behavior instead of a broken proposal.
      return undefined;
    }
    if (!text.trim()) return undefined;
    this.lastTurnsCompact = 0;
    return {
      summary: text,
      firstKeptEntryId: floor,
      tokensBefore: preparation.tokensBefore,
      usage,
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

  stats(): { compactions: number; boundary: string | undefined } {
    return { compactions: this.compactions, boundary: this.boundaryEntryId };
  }
}