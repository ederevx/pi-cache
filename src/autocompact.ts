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
 * signal, and a TTL-based idle-time ramp; it feeds the
 * economics read rate rather than a raw utilization ramp (the pressure
 * model owns the probability math and the draw).
 *
 * Every predicate (`decide`, `midtermEligible`, the /cache-stats
 * `currentPressure` preview) reads the SAME evaluated sample: the last
 * completed turn gates that a turn happened, the freshest request of any
 * kind measures warmth, and the normalized view supplies the tokens and
 * window. Only `decide` consumes the RNG draw; the midterm predicate reads
 * the draw-free probability, so it cannot perturb the decision.
 *
 * `cacheNeutral` (fast compaction on) relaxes the warm-cache floor, because
 * the fast override makes the compaction itself prefix-stable.
 *
 * `markCompacted()` is called from the `session_compact` hook for EVERY
 * completed compaction, including pi's own threshold/overflow run, so the
 * cooldown and counter stay tied to reality.
 */

import type { CompactionPressure, PressureSample, PressureVerdict } from "./pressure.ts";
import type { CostRates } from "./economics.ts";

export interface AutocompactSignal {
  /** Last completed turn's usage, if any. */
  lastUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined;
  /** Newest request usage of any kind (turn or warm refresh); the freshest
   *  measurement of the cache's warmth. Falls back to `lastUsage` when absent. */
  lastRequestUsage?(): { input: number; cacheRead: number; cacheWrite: number } | undefined;
  /** Milliseconds since the last completed turn (TTL-gap ramp). */
  msSinceLastTurn(): number;
  /** Milliseconds since the cache was last touched (last turn or a pi warm
   *  refresh); falls back to `msSinceLastTurn` when absent. */
  msSinceCacheTouch?(): number;
  /** Number of times the prefix head changed this session (normalizer.churn). */
  headChurn(): number;
  /** Provider cache lifetime in ms when known (model.promptCache tier). */
  cacheTtlMs?(): number | undefined;
  /** Model cache cost rates; absent means economics is unavailable. The
   *  live token count selects a request-wide pricing tier when the model
   *  in use has one. */
  costRates?(tokens?: number): CostRates | undefined;
}

/** The cache-timing pair the economics horizon needs (both or neither). */
interface CacheTiming {
  ttlMs?: number;
  msSinceCacheTouch?: number;
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

interface AutocompactUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One evaluated pressure sample for a live context view. */
interface Evaluation {
  churned: boolean;
  coldness: number;
  /** Absent when the model/window cannot produce a pressure sample. */
  sample?: PressureSample;
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
  /** Allow the mid-run trigger when the pressure is saturated and the
   *  window is at least half full (default off; wired from options). */
  midterm?: boolean;
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
  /** Window occupancy at/above which a saturated-pressure midterm fire is allowed. */
  private static readonly MIDTERM_MIN_CONTEXT_PERCENT = 50;
  /** Minimum turns between automatic compactions. */
  private static readonly COOLDOWN_TURNS = 5;
  /** Default coldness floor below which a warm cache is never compacted. */
  private static readonly DEFAULT_COLD_FLOOR = 0.2;
  /** Default minimum live context before economics pressure may fire. */
  private static readonly DEFAULT_MIN_TOKENS = 50_000;

  /** Session turns seen, counted here rather than read from pi's per-run
   *  `turnIndex` (which resets to 0 on every `agent_start`), so the turn
   *  cooldown is monotonic across runs. */
  private turnsSeen = 0;
  /** Whether any compaction completed this session. */
  private hasCompacted = false;
  /** Wall clock and session-turn count of the last completed compaction. */
  private compactedAt = 0;
  private compactedTurn = 0;
  /** Successful compactions this session (telemetry for /cache-stats). */
  private compactions = 0;

  private readonly opts: AutocompactOptions;
  private cacheNeutral: boolean;
  private midterm: boolean;

  constructor(opts: AutocompactOptions) {
    this.opts = opts;
    this.cacheNeutral = opts.cacheNeutral ?? false;
    this.midterm = opts.midterm ?? false;
  }

  /** Turn bookkeeping: one call per completed turn (turn_end), so the
   *  cooldown counts real turns across every run in the session. */
  noteTurn(): void {
    this.turnsSeen++;
  }

  /** Live switch: fast compaction changed from /cache-settings. */
  setCacheNeutral(cacheNeutral: boolean): void {
    this.cacheNeutral = cacheNeutral;
  }

  /** The live midterm (in-run) compaction switch. */
  get midtermEnabled(): boolean {
    return this.midterm;
  }

  /** Live switch: midterm compaction changed from /cache-settings. */
  setMidtermEnabled(midterm: boolean): void {
    this.midterm = midterm;
  }

  /** The live auto-compaction master switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Live switch: auto-compaction changed from /cache-settings. */
  setEnabled(enabled: boolean): void {
    this.opts.enabled = enabled;
  }

  /** Decide after a run settled (agent_settled guarantees idle). */
  decide(
    usageOrPercent: number | ContextUsageLike | undefined,
    signals: AutocompactSignal,
  ): AutocompactVerdict {
    if (!this.opts.enabled) return { shouldCompact: false, reason: undefined };
    const usage = this.liveUsage(signals);
    if (!usage) return { shouldCompact: false, reason: "no usage yet" };

    const view = this.readContext(usageOrPercent);
    const { churned, coldness, sample } = this.evaluate(view, usage, signals);
    // A warm, non-churned cache is never compacted without fast compaction:
    // the summarizer plus a full prefix re-write would be charged fresh.
    if (!churned && !this.cacheNeutral && coldness < this.coldFloor()) {
      return { shouldCompact: false, reason: "cache warm", coldness };
    }

    const verdict = sample ? this.opts.pressure?.sample(sample) : undefined;
    const base = { pressure: verdict?.pressure, probability: verdict?.probability, coldness };
    if (verdict) {
      // The expected-cost term is flat in token count, so without a floor it
      // fires on a trivially small context that pi refuses to compact.
      if (this.belowMinimum(view)) {
        return { shouldCompact: false, reason: "context below minimum", ...base };
      }
      if (!verdict.fire) {
        return { shouldCompact: false, reason: "pressure below draw", ...base };
      }
    } else if (!AutocompactController.atLeastPercent(view, AutocompactController.MIN_CONTEXT_PERCENT)) {
      return { shouldCompact: false, reason: "context below threshold", ...base };
    }
    if (!this.cooldownElapsed()) {
      return { shouldCompact: false, reason: "cooldown", ...base };
    }
    return { shouldCompact: true, reason: this.reason(churned, verdict !== undefined), ...base };
  }

  /**
   * Mid-run eligibility: the in-run trigger may fire only when the
   * pressure is saturated (probability 1) and the window is at least half
   * full. A pure predicate with no RNG draw, so the caller can gate the
   * existing trigger without perturbing the probabilistic decision; the
   * warm-cache floor and cooldown are still applied by the trigger path.
   */
  midtermEligible(
    usageView: ContextUsageLike | undefined,
    signals: AutocompactSignal,
  ): boolean {
    if (!this.opts.enabled || !this.midterm) return false;
    const usage = this.liveUsage(signals);
    if (!usage) return false;
    const view = this.readContext(usageView);
    if (!AutocompactController.atLeastPercent(view, AutocompactController.MIDTERM_MIN_CONTEXT_PERCENT)) {
      return false;
    }
    const { sample } = this.evaluate(view, usage, signals);
    const probability = sample ? this.opts.pressure?.probability(sample) : undefined;
    if (probability === undefined || probability < 1) return false;
    return this.cooldownElapsed();
  }

  /** Whether the sampled window has reached `percent` of its context window. */
  private static atLeastPercent(view: AutocompactView, percent: number): boolean {
    const pct =
      typeof view.percent === "number"
        ? view.percent
        : typeof view.tokens === "number" &&
            typeof view.contextWindow === "number" &&
            view.contextWindow > 0
          ? (view.tokens / view.contextWindow) * 100
          : undefined;
    return typeof pct === "number" && pct >= percent;
  }

  /**
   * Public preview for /cache-stats: the current pressure verdict for a
   * live context sample, or undefined when it cannot be sampled.
   */
  currentPressure(
    usageView: ContextUsageLike | undefined,
    usage: AutocompactUsage | undefined,
    signals?: AutocompactSignal,
  ): PressureVerdict | undefined {
    if (!usage) return undefined;
    const { sample } = this.evaluate(this.readContext(usageView), usage, signals);
    return sample ? this.opts.pressure?.sample(sample) : undefined;
  }

  /**
   * Evaluate one context view: churn, coldness, and the pressure sample
   * every predicate shares. Draws nothing, so the caller chooses whether to
   * consume `sample` (the decision) or read its draw-free `probability`
   * (the midterm gate).
   */
  private evaluate(
    view: AutocompactView,
    usage: AutocompactUsage,
    signals?: AutocompactSignal,
  ): Evaluation {
    const churned = signals !== undefined && this.churned(signals);
    const coldness = this.coldness(usage, churned, signals);
    return {
      churned,
      coldness,
      sample: this.pressureInput(
        view,
        usage,
        coldness,
        signals?.costRates?.(view.tokens),
        this.cacheTiming(signals),
      ),
    };
  }

  /**
   * The turn-gated usage every predicate starts from: a completed turn must
   * exist, and the freshest request of any kind then measures warmth.
   */
  private liveUsage(signals: AutocompactSignal): AutocompactUsage | undefined {
    const turnUsage = signals.lastUsage();
    if (!turnUsage) return undefined;
    return signals.lastRequestUsage?.() ?? turnUsage;
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

  /** Whether the prefix head churned. */
  private churned(signals: AutocompactSignal): boolean {
    return signals.headChurn() > 0;
  }

  /**
   * Coldness in [0,1]: churn/rotation is definitively cold; otherwise the
   * last request's cached share and the idle/TTL ramp are combined by their
   * maximum so the cache never looks warmer than either signal.
   */
  private coldness(
    usage: AutocompactUsage,
    churned: boolean,
    signals?: AutocompactSignal,
  ): number {
    if (churned) return 1;
    const observed = this.observedColdness(usage);
    const ttlMs = signals?.cacheTtlMs?.();
    if (!signals || typeof ttlMs !== "number" || ttlMs <= 0) return observed;
    const idleMs = signals.msSinceCacheTouch?.() ?? signals.msSinceLastTurn();
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

  /** The pressure sample for a live context view, or undefined without the
   *  model, a token count, or a window. */
  private pressureInput(
    view: AutocompactView,
    usage: AutocompactUsage,
    coldness: number,
    rates: CostRates | undefined,
    timing: CacheTiming,
  ): PressureSample | undefined {
    if (
      !this.opts.pressure ||
      typeof view.tokens !== "number" ||
      typeof view.contextWindow !== "number"
    ) {
      return undefined;
    }
    return {
      tokens: view.tokens,
      contextWindow: view.contextWindow,
      coldness,
      rates,
      // Fast compaction replaces the summarizer, so its cost is zero.
      summaryCost: this.cacheNeutral ? 0 : Math.max(0, this.opts.summaryCost ?? 0),
      cacheRead: usage.cacheRead,
      input: usage.input,
      ttlMs: timing.ttlMs,
      msSinceCacheTouch: timing.msSinceCacheTouch,
    };
  }

  /** The positive TTL and finite touch age the horizon may decay against. */
  private cacheTiming(signals?: AutocompactSignal): CacheTiming {
    const ttlMs = signals?.cacheTtlMs?.();
    const touch = signals?.msSinceCacheTouch?.() ?? signals?.msSinceLastTurn();
    return {
      ttlMs: typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : undefined,
      msSinceCacheTouch:
        typeof touch === "number" && Number.isFinite(touch) ? touch : undefined,
    };
  }

  /** Whether the seconds/turns cooldown since the last compaction elapsed. */
  private cooldownElapsed(): boolean {
    if (!this.hasCompacted) return true;
    return (
      Date.now() - this.compactedAt >= this.opts.cooldownSeconds * 1000 &&
      this.turnsSeen - this.compactedTurn >= AutocompactController.COOLDOWN_TURNS
    );
  }

  private reason(churned: boolean, fromPressure: boolean): string {
    if (fromPressure) return "compaction pressure";
    return churned ? "churned prefix + context threshold" : "cold window + context threshold";
  }

  /** Record a successful compaction: reset cooldowns and count it. */
  markCompacted(): void {
    this.compactedAt = Date.now();
    this.compactedTurn = this.turnsSeen;
    this.hasCompacted = true;
    this.compactions++;
  }

  stats(): { compactions: number } {
    return { compactions: this.compactions };
  }
}
