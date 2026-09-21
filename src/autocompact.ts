/**
 * pi-cache — cache-aware auto-compaction controller.
 *
 * One responsibility: decide whether to programmatically trigger
 * compaction, and when, and to account for every completed compaction.
 * Compaction itself is cache-transparent (pi summarizes with
 * cacheRetention:"none" and a fresh routing session), so the only
 * cache-aware choice is WHEN: the expensive part (summarizer plus the next
 * full prefix re-write) should land in a window that is already cold, never
 * mid-warm-cache.
 *
 * Compaction pressure: the context gate is a probabilistic draw from an
 * injected `CompactionPressure`, which blends context degradation with
 * the expected cost of continuing versus rewriting the prefix. Coldness is
 * computed here from the last request's cached share, the prefix-head churn
 * / affinity-rotation signals, and a TTL-based idle-time ramp; it feeds the
 * economics read rate rather than a raw utilization ramp (the pressure
 * model owns the probability math and the draw).
 *
 * `cacheNeutral` (fast compaction on) relaxes the warm-cache floor, because
 * the fast override makes the compaction itself prefix-stable.
 *
 * `markCompacted()` is called from the `session_compact` hook for EVERY
 * completed compaction, including pi's own threshold/overflow run, so the
 * cooldown and counter stay tied to reality.
 */

import type { CompactionPressure, PressureVerdict } from "./pressure.ts";
import type { CostRates } from "./economics.ts";

export interface AutocompactSignal {
  /** Last completed turn's usage, if any. */
  lastUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined;
  /** Milliseconds since the last completed turn (TTL-gap ramp). */
  msSinceLastTurn(): number;
  /** Number of times the prefix head changed this session (normalizer.churn). */
  headChurn(): number;
  /** Whether the provider session-affinity header has rotated (affinity.rotated). */
  affinityRotated(): boolean;
  /** Provider cache lifetime in ms when known (model.promptCache tier). */
  cacheTtlMs?(): number | undefined;
  /** Model cache cost rates; absent means economics is unavailable. */
  costRates?(): CostRates | undefined;
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
  /** Coldness at/below which a non-churned cache is warm (default 0.2). */
  coldFloor?: number;
  /** Fast compaction is active, so a compaction is prefix-stable and a warm
   *  window costs nothing extra: relax the coldness floor and charge no
   *  summarizer cost. */
  cacheNeutral?: boolean;
  /** Non-fast summarizer cost in per-million tokens (0 default). */
  summaryCost?: number;
  /** Minimum live context tokens before economics pressure may fire;
   *  0 or negative disables the floor. */
  minTokens?: number;
  /** Probabilistic pressure model; absent = fixed percent threshold. */
  pressure?: CompactionPressure;
}

export interface AutocompactVerdict {
  shouldCompact: boolean;
  reason: string | undefined;
  /** Reported pressure/probability when the pressure model decided. */
  pressure?: number;
  probability?: number;
  /** Cache coldness (0 warm .. 1 cold) used for this decision. */
  coldness?: number;
}

export class AutocompactController {
  /** cacheRead / (cacheRead + input) at or below this = the cache is cold. */
  private static readonly COLD_RATIO = 0.05;
  /** cacheRead share at or above this = the cache is warm (coldness 0). */
  private static readonly WARM_SHARE = 0.5;
  /** getContextUsage().percent at or above this is required to trigger. */
  private static readonly MIN_CONTEXT_PERCENT = 60;
  /** Minimum turns between automatic compactions. */
  private static readonly COOLDOWN_TURNS = 5;
  /** Default coldness floor below which a warm cache is never compacted. */
  private static readonly DEFAULT_COLD_FLOOR = 0.2;
  /** Default minimum live context before economics pressure may fire. */
  private static readonly DEFAULT_MIN_TOKENS = 50_000;

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
    const churned = this.churned(signals);
    const coldness = this.coldness(usage, churned, signals);
    // A warm, non-churned cache is never compacted without fast compaction:
    // the summarizer plus a full prefix re-write would be charged fresh.
    if (!churned && !this.cacheNeutral && coldness < this.coldFloor()) {
      return { shouldCompact: false, reason: "cache warm", coldness };
    }

    const gate = this.contextGate(view, usage, coldness, signals.costRates?.());
    if (!gate.allowed) {
      return {
        shouldCompact: false,
        reason: gate.reason,
        pressure: gate.pressure,
        probability: gate.probability,
        coldness,
      };
    }
    if (!this.cooldownElapsed()) {
      return {
        shouldCompact: false,
        reason: "cooldown",
        pressure: gate.pressure,
        probability: gate.probability,
        coldness,
      };
    }
    return {
      shouldCompact: true,
      reason: this.reason(churned, gate.fromPressure),
      pressure: gate.pressure,
      probability: gate.probability,
      coldness,
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

  /** Whether the prefix head churned or the affinity header rotated. */
  private churned(signals: AutocompactSignal): boolean {
    return signals.headChurn() > 0 || signals.affinityRotated();
  }

  /**
   * Coldness in [0,1]: churn/rotation is definitively cold; otherwise the
   * last request's cached share and the idle/TTL ramp are combined by their
   * maximum so the cache never looks warmer than either signal.
   */
  private coldness(
    usage: { input: number; cacheRead: number; cacheWrite: number },
    churned: boolean,
    signals?: AutocompactSignal,
  ): number {
    if (churned) return 1;
    const observed = this.observedColdness(usage);
    const ttlMs = signals?.cacheTtlMs?.();
    if (!signals || typeof ttlMs !== "number" || ttlMs <= 0) return observed;
    const idleMs = signals.msSinceLastTurn();
    if (!Number.isFinite(idleMs) || idleMs <= 0) return observed;
    return Math.max(observed, Math.min(1, idleMs / ttlMs));
  }

  /** Cached-share ramp: <=5% is cold (1), >=50% is warm (0), linear between. */
  private observedColdness(usage: { input: number; cacheRead: number }): number {
    const requestTokens = Math.max(0, usage.cacheRead) + Math.max(0, usage.input);
    if (requestTokens <= 0) return 0;
    const share = Math.max(0, usage.cacheRead) / requestTokens;
    const span = AutocompactController.WARM_SHARE - AutocompactController.COLD_RATIO;
    const cold = (AutocompactController.WARM_SHARE - share) / span;
    return Math.max(0, Math.min(1, cold));
  }

  private coldFloor(): number {
    return this.opts.coldFloor ?? AutocompactController.DEFAULT_COLD_FLOOR;
  }

  /** Minimum live context tokens before economics pressure may fire. */
  private minTokens(): number {
    return this.opts.minTokens ?? AutocompactController.DEFAULT_MIN_TOKENS;
  }

  /** Whether the sampled context is below the economics pressure floor. */
  private belowMinimum(view: AutocompactView): boolean {
    const floor = this.minTokens();
    return floor > 0 && typeof view.tokens === "number" && view.tokens < floor;
  }

  /**
   * Public preview for /cache-stats: the current pressure verdict for a
   * live context sample, or undefined when it cannot be sampled.
   */
  currentPressure(
    usageView: ContextUsageLike | undefined,
    usage: { input: number; cacheRead: number; cacheWrite: number } | undefined,
    signals?: AutocompactSignal,
  ): PressureVerdict | undefined {
    if (!usage) return undefined;
    const churned = signals !== undefined && this.churned(signals);
    const coldness = this.coldness(usage, churned, signals);
    return this.samplePressure(this.readContext(usageView), usage, coldness, signals?.costRates?.());
  }

  /**
   * Context gate: a probabilistic pressure draw when the model and a token
   * count exist, else the fixed percent threshold.
   */
  private contextGate(
    view: AutocompactView,
    usage: { input: number; cacheRead: number; cacheWrite: number },
    coldness: number,
    rates: CostRates | undefined,
  ): {
    allowed: boolean;
    reason?: string;
    pressure?: number;
    probability?: number;
    fromPressure: boolean;
  } {
    const verdict = this.samplePressure(view, usage, coldness, rates);
    if (verdict) {
      // The expected-cost term is flat in token count, so without a floor it
      // fires on a trivially small context that pi refuses to compact.
      if (this.belowMinimum(view)) {
        return {
          allowed: false,
          reason: "context below minimum",
          pressure: verdict.pressure,
          probability: verdict.probability,
          fromPressure: true,
        };
      }
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
    coldness: number,
    rates: CostRates | undefined,
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
      coldness,
      rates,
      // Fast compaction replaces the summarizer, so its cost is zero.
      summaryCost: this.cacheNeutral ? 0 : Math.max(0, this.opts.summaryCost ?? 0),
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