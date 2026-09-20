/**
 * pi-cache — cache-aware auto-compaction controller.
 *
 * One responsibility: decide whether to programmatically trigger
 * compaction, and when. Compaction itself is cache-transparent (pi
 * summarizes with cacheRetention:"none" and a fresh routing session), so
 * the only cache-aware choice is WHEN: the expensive part (summarizer
 * plus the next full prefix re-write) should land in a window that is
 * already cold, never mid-warm-cache.
 *
 * Trigger rule (default on; disable with PI_CACHE_AUTO_COMPACT=0): after
 * a turn that came back with ~0 cacheRead while context usage is above
 * the configured percent threshold — or when the prefix head is churning
 * (tools/system not byte-stable) or the provider session-affinity header
 * is rotating, both of which already invalidate the provider cache — call
 * ctx.compact(). A ~0 cacheRead turn means the provider prefix was lost
 * anyway (TTL expiry after a gap, provider move, churn), so compaction
 * piles no extra write cost on a warm window.
 *
 * Compaction pressure: when a `CompactionPressure` model is supplied, the
 * fixed percent threshold is replaced by a probabilistic draw whose
 * probability rises with context tokens (and cache/cold economics), so a
 * larger context is monotonically more likely to compact. `cacheNeutral`
 * (fast compaction on) relaxes the cold-window requirement, because the
 * fast override makes the compaction itself prefix-stable.
 *
 * Guards (audit, docs/implementation-reference.md): only fire when the
 * agent is idle (agent_settled / ctx.isIdle); only when no compaction
 * entry is last in the session; never within the cooldown window; fire-
 * and-forget via callbacks; all decisions owned here.
 */

import type { CompactionPressure, PressureVerdict } from "./pressure.ts";

export interface AutocompactSignal {
  /** Last completed turn's usage, if any. */
  lastUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined;
  /** Milliseconds since the last completed turn (for TTL-gap detection). */
  msSinceLastTurn(): number;
  /** Number of times the prefix head changed this session (normalizer.churn). */
  headChurn(): number;
  /** Whether the provider session-affinity header has rotated (affinity.rotated). */
  affinityRotated(): boolean;
}

/** The context-usage fields the controller reads (pi's `ContextUsage`). */
export interface ContextUsageLike {
  percent?: number | null;
  tokens?: number | null;
  contextWindow?: number;
}

/** Normalized (non-null) context view used by the decision helpers. */
interface AutocompactView {
  percent?: number;
  tokens?: number;
  contextWindow?: number;
}

export interface AutocompactOptions {
  enabled: boolean;
  /** Minimum seconds between automatic compactions. */
  cooldownSeconds: number;
  /** Minimum idle-so-far gap (s) that indicates a provider TTL expired. */
  minGapSeconds: number;
  /**
   * Fast compaction is active, so a compaction is prefix-stable and a warm
   * window costs nothing extra: relax the cold/churn requirement.
   */
  cacheNeutral?: boolean;
  /** Probabilistic pressure model; absent = fixed percent threshold. */
  pressure?: CompactionPressure;
}

export interface AutocompactVerdict {
  shouldCompact: boolean;
  reason: string | undefined;
  /** Reported pressure/probability when the pressure model decided. */
  pressure?: number;
  probability?: number;
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
  /** Successful compactions this session (telemetry for /cache-stats). */
  private compactions = 0;

  private readonly opts: AutocompactOptions;
  private cacheNeutral: boolean;

  constructor(opts: AutocompactOptions) {
    this.opts = opts;
    this.cacheNeutral = opts.cacheNeutral ?? false;
  }

  /** Turn bookkeeping: called from turn_end so agent_settled can evaluate. */
  noteTurn(turnIndex: number): void {
    this.lastTurnIndex = turnIndex;
  }

  /** Live switch: fast compaction changed from /cache-settings. */
  setCacheNeutral(cacheNeutral: boolean): void {
    this.cacheNeutral = cacheNeutral;
  }

  /** Decide after a run settled (agent_settled guarantees idle). */
  decide(
    usageOrPercent: number | ContextUsageLike | undefined,
    signals: AutocompactSignal,
  ): AutocompactVerdict {
    if (!this.opts.enabled) return { shouldCompact: false, reason: undefined };
    const usage = signals.lastUsage();
    if (!usage) return { shouldCompact: false, reason: "no usage yet" };

    const view = this.readContext(usageOrPercent);
    const { cold, churned } = this.cacheState(usage, signals);
    // Without fast compaction a warm window must not be compacted (the
    // summarizer plus full prefix re-write would be charged fresh).
    if (!cold && !churned && !this.cacheNeutral) {
      return { shouldCompact: false, reason: "cache warm" };
    }

    const gate = this.contextGate(view, usage);
    if (!gate.allowed) {
      return {
        shouldCompact: false,
        reason: gate.reason,
        pressure: gate.pressure,
        probability: gate.probability,
      };
    }
    if (!this.cooldownElapsed()) {
      return {
        shouldCompact: false,
        reason: "cooldown",
        pressure: gate.pressure,
        probability: gate.probability,
      };
    }
    // Only a TTL-style cold gap needs a minimum elapsed time to confirm the
    // provider prefix was truly lost; churn/rotation and cache-neutral fast
    // compaction are already visible/safe, so the gap requirement is waived.
    if (!churned && !this.cacheNeutral && !this.gapElapsed(signals)) {
      return {
        shouldCompact: false,
        reason: "cold without a gap",
        pressure: gate.pressure,
        probability: gate.probability,
      };
    }
    return {
      shouldCompact: true,
      reason: this.reason(churned, gate.fromPressure),
      pressure: gate.pressure,
      probability: gate.probability,
    };
  }

  /** Normalize the caller's number/ContextUsage into a plain view. */
  private readContext(usageOrPercent: number | ContextUsageLike | undefined): AutocompactView {
    if (typeof usageOrPercent === "number") return { percent: usageOrPercent };
    return {
      percent: usageOrPercent?.percent ?? undefined,
      tokens: usageOrPercent?.tokens ?? undefined,
      contextWindow: usageOrPercent?.contextWindow,
    };
  }

  /** Whether the provider prefix is already cold, and whether it churned. */
  private cacheState(
    usage: { input: number; cacheRead: number; cacheWrite: number },
    signals: AutocompactSignal,
  ): { cold: boolean; churned: boolean } {
    const requestTokens = usage.cacheRead + usage.input;
    const cold =
      requestTokens > 0 &&
      usage.cacheRead / requestTokens <= AutocompactController.COLD_RATIO;
    // A churning prefix head (tools/system not byte-stable) or a rotating
    // provider session-affinity header invalidates the provider cache
    // regardless of TTL — the window is already cold, so the cost of
    // compaction is not additive here.
    const churned = signals.headChurn() > 0 || signals.affinityRotated();
    return { cold, churned };
  }

  /**
   * Public preview for /cache-stats: the current pressure verdict for a
   * live context sample, or undefined when it cannot be sampled.
   */
  currentPressure(
    usageView: ContextUsageLike | undefined,
    usage: { input: number; cacheRead: number; cacheWrite: number } | undefined,
  ): PressureVerdict | undefined {
    if (!usage) return undefined;
    return this.samplePressure(this.readContext(usageView), usage);
  }

  /**
   * Context gate: a probabilistic pressure draw when the model and a token
   * count exist, else the fixed percent threshold.
   */
  private contextGate(
    view: AutocompactView,
    usage: { input: number; cacheRead: number; cacheWrite: number },
  ): {
    allowed: boolean;
    reason?: string;
    pressure?: number;
    probability?: number;
    fromPressure: boolean;
  } {
    const verdict = this.samplePressure(view, usage);
    if (verdict) {
      return {
        allowed: verdict.fire,
        reason: verdict.fire ? undefined : "pressure below draw",
        pressure: verdict.pressure,
        probability: verdict.probability,
        fromPressure: true,
      };
    }
    if (
      typeof view.percent !== "number" ||
      view.percent < AutocompactController.MIN_CONTEXT_PERCENT
    ) {
      return { allowed: false, reason: "context below threshold", fromPressure: false };
    }
    return { allowed: true, fromPressure: false };
  }

  /** Sample the pressure model, or undefined without tokens + window. */
  private samplePressure(
    view: AutocompactView,
    usage: { input: number; cacheRead: number; cacheWrite: number },
  ): PressureVerdict | undefined {
    if (
      !this.opts.pressure ||
      typeof view.tokens !== "number" ||
      typeof view.contextWindow !== "number"
    ) {
      return undefined;
    }
    return this.opts.pressure.sample({
      tokens: view.tokens,
      contextWindow: view.contextWindow,
      reserveTokens: 0,
      cacheRead: usage.cacheRead,
      input: usage.input,
    });
  }

  /** Whether the seconds/turns cooldown since the last compaction elapsed. */
  private cooldownElapsed(): boolean {
    const neverCompacted = this.lastCompactedTurn < 0;
    return (
      (neverCompacted ||
        Date.now() - this.lastCompactedAt >= this.opts.cooldownSeconds * 1000) &&
      (neverCompacted ||
        this.lastTurnIndex - this.lastCompactedTurn >= AutocompactController.COOLDOWN_TURNS)
    );
  }

  /** Whether enough idle time passed to confirm a provider TTL expiry. */
  private gapElapsed(signals: AutocompactSignal): boolean {
    return signals.msSinceLastTurn() >= this.opts.minGapSeconds * 1000;
  }

  private reason(churned: boolean, fromPressure: boolean): string {
    if (fromPressure) return "compaction pressure";
    return churned ? "churned prefix + context threshold" : "cold window + context threshold";
  }

  /** Record a successful compaction: reset cooldowns and count it. */
  markCompacted(): void {
    this.lastCompactedAt = Date.now();
    this.lastCompactedTurn = this.lastTurnIndex;
    this.compactions++;
  }

  stats(): { compactions: number } {
    return { compactions: this.compactions };
  }
}
