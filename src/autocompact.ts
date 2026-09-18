/**
 * pi-cache — cache-aware auto-compaction controller.
 *
 * One responsibility: decide whether to programmatically trigger
 * compaction, and when. Compaction itself is cache-transparent (pi
 * summarizes with cacheRetention:"none" and a fresh routing session),
 * so the only cache-aware choice is WHEN: the expensive part (summarizer
 * plus the next full prefix re-write) should land in a window that is
 * already cold, never mid-warm-cache.
 *
 * Trigger rule (opt-in): after a turn that came back with ~0 cacheRead
 * while context usage is above the configured percent threshold, call
 * ctx.compact(). A ~0 cacheRead turn means the provider prefix was lost
 * anyway (TTL expiry after a gap, provider move, churn), so compaction
 * piles no extra write cost on a warm window.
 *
 * Guards (audit, docs/implementation-reference.md): only fire when the
 * agent is idle (agent_settled / ctx.isIdle); only when no compaction
 * entry is last in the session; never within the cooldown window; fire-
 * and-forget via callbacks; all decisions owned here.
 */

export interface AutocompactSignal {
  /** Last completed turn's usage, if any. */
  lastUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined;
  /** Milliseconds since the last completed turn (for TTL-gap detection). */
  msSinceLastTurn(): number;
}

export interface AutocompactOptions {
  enabled: boolean;
  /** Minimum seconds between automatic compactions. */
  cooldownSeconds: number;
  /** Minimum idle-so-far gap (s) that indicates a provider TTL expired. */
  minGapSeconds: number;
}

export interface AutocompactVerdict {
  shouldCompact: boolean;
  reason: string | undefined;
}

export class AutocompactController {
  /** cacheRead / (cacheRead + input) at or below this = the cache is cold. */
  private static readonly COLD_RATIO = 0.05;
  /** getContextUsage().percent at or above this is required to trigger. */
  private static readonly MIN_CONTEXT_PERCENT = 60;
  /** Minimum turns between automatic compactions. */
  private static readonly COOLDOWN_TURNS = 5;

  private lastCompactedAt = 0;
  private lastCompactedTurn = -1;
  private lastTurnIndex = 0;

  constructor(private readonly opts: AutocompactOptions) {}

  /** Turn bookkeeping: called from turn_end so agent_settled can evaluate. */
  noteTurn(turnIndex: number): void {
    this.lastTurnIndex = turnIndex;
  }

  /** Decide after a run settled (agent_settled guarantees idle). */
  decide(
    contextPercent: number | undefined,
    signals: AutocompactSignal,
  ): AutocompactVerdict {
    if (!this.opts.enabled) return { shouldCompact: false, reason: undefined };
    const usage = signals.lastUsage();
    if (!usage) return { shouldCompact: false, reason: "no usage yet" };
    const cold = usage.cacheRead + usage.input > 0
      ? usage.cacheRead / (usage.cacheRead + usage.input) <= AutocompactController.COLD_RATIO
      : false;
    if (!cold) return { shouldCompact: false, reason: "cache warm" };
    if (
      typeof contextPercent !== "number" ||
      contextPercent < AutocompactController.MIN_CONTEXT_PERCENT
    ) {
      return { shouldCompact: false, reason: "context below threshold" };
    }
    const gapMs = signals.msSinceLastTurn();
    const neverCompacted = this.lastCompactedTurn < 0;
    const cooldownOk =
      (neverCompacted ||
        Date.now() - this.lastCompactedAt >= this.opts.cooldownSeconds * 1000) &&
      (neverCompacted ||
        this.lastTurnIndex - this.lastCompactedTurn >= AutocompactController.COOLDOWN_TURNS);
    if (!cooldownOk) return { shouldCompact: false, reason: "cooldown" };
    if (gapMs < this.opts.minGapSeconds * 1000) {
      return { shouldCompact: false, reason: "cold without a gap" };
    }
    return { shouldCompact: true, reason: "cold window + context threshold" };
  }

  /** Record a successful compaction to reset the cooldowns. */
  markCompacted(): void {
    this.lastCompactedAt = Date.now();
    this.lastCompactedTurn = this.lastTurnIndex;
  }
}