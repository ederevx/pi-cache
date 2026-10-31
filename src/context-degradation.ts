/**
 * pi-cache — context degradation.
 *
 * One responsibility: map context occupancy and active context age onto a
 * `[0,1]` degradation pressure. Long-context answer quality degrades below
 * the advertised window, and the research says so with two shapes that this
 * model keeps apart:
 *
 *  - *Length.* RULER (arXiv 2404.06654, COLM 2024) reports large drops as
 *    the context grows and only half of seventeen long-context models
 *    holding up at 32K. NoLiMa (arXiv 2502.05167, ICML 2025) puts eleven of
 *    thirteen models below half their short-context baseline at 32K, and
 *    Databricks (arXiv 2411.03538) finds only a handful staying consistent
 *    above 64K. Chroma's "Context Rot" (research.trychroma.com/context-rot)
 *    finds the decline non-uniform and strongly model- and task-dependent.
 *    So an absolute token count is evidence of degradation that rises from
 *    `floorStartTokens` to `floorFullTokens` and then plateaus at `floor`
 *    (default 0.5, clamped to `[0,1]`): it is a *minimum* on the pressure,
 *    never a ceiling, because which count is the real onset differs per
 *    model. Only an explicit `floor = 1` lets length alone saturate.
 *  - *Occupancy.* The fractional `start`/`full` ramp toward the advertised
 *    window is what carries the pressure the rest of the way to the window
 *    limit. It is unchanged and uncapped: a window small enough to be
 *    trusted keeps exactly the curve it had.
 *
 * For a window so large that the fractional ramp cannot start until after
 * the lengths the research measured (or one whose size is unknown), neither
 * of those says anything useful, and a third reason takes over: *active
 * time*. Content accumulated over hours degrades more than the same content
 * accumulated over minutes, discounted by a half-life so the term saturates
 * slowly instead of becoming a cliff at some age. The three reasons combine
 * by inclusion-exclusion, the same either-reason-suffices rule the pressure
 * blend already uses, which keeps the result bounded in `[0,1]` and monotone
 * in both arguments. Owns only its options; no mutable state.
 */

export interface ContextDegradationOptions {
  /** Occupancy fraction at/below which the fractional ramp is 0. */
  start: number;
  /** Occupancy fraction at/above which the fractional ramp is 1. */
  full: number;
  /** Curve exponent (>1 keeps the fractional ramp near 0 through the onset). */
  gamma: number;
  /** Absolute token count where the research floor starts (<=0 disables it). */
  floorStartTokens: number;
  /** Absolute token count where the research floor plateaus. */
  floorFullTokens: number;
  /** Floor plateau in `[0,1]`: the most absolute length alone can claim. */
  floor: number;
  /** Active-age half-life (ms) for windows too large to trust (<=0 disables). */
  halfLifeMs: number;
}

export class ContextDegradation {
  private static readonly DEFAULTS: ContextDegradationOptions = {
    start: 0.5,
    full: 0.85,
    gamma: 2,
    // 32 768: the length at which RULER and NoLiMa both put the majority of
    // models below their short-context quality, so the latest defensible
    // onset for a *floor* on absolute length.
    floorStartTokens: 32_768,
    // 131 072: the largest length the evidence reaches (Databricks at 128K,
    // and NoLiMa's appendix at 64K-128K for the two models it extends that
    // far). The floor stops climbing there rather than extrapolate past it.
    floorFullTokens: 131_072,
    // Unvalidated policy default. A floor of 1 would let length alone
    // saturate the pressure, so the default leaves room for the ramp and the
    // age term; the value is clamped to [0,1], and only an explicit 1 makes
    // length alone reach a saturation.
    floor: 0.5,
    // Unvalidated policy default: no cited work measures wall-clock age.
    halfLifeMs: 60 * 60 * 1000,
  };

  private readonly opts: ContextDegradationOptions;

  constructor(opts: Partial<ContextDegradationOptions> = {}) {
    const merged = { ...ContextDegradation.DEFAULTS, ...opts };
    // Every number is taken from the caller only when it is finite, so a
    // single bad setting degrades to the default instead of turning the
    // pressure (and every comparison against it) into NaN.
    const floorStart = ContextDegradation.finite(
      merged.floorStartTokens,
      ContextDegradation.DEFAULTS.floorStartTokens,
    );
    // The two occupancy fractions are clamped to the unit interval: outside
    // it the ramp would start before zero tokens (a negative onset) or the
    // unlimited test would fire for windows far below the research range.
    const start = ContextDegradation.clamp(
      ContextDegradation.finite(merged.start, ContextDegradation.DEFAULTS.start),
    );
    const full = Math.max(
      start,
      ContextDegradation.clamp(
        ContextDegradation.finite(merged.full, ContextDegradation.DEFAULTS.full),
      ),
    );
    this.opts = {
      start,
      full,
      // A negative exponent would invert the ramp (and make a zero ramp
      // Infinity), so the exponent is clamped non-negative.
      gamma: Math.max(0, ContextDegradation.finite(merged.gamma, ContextDegradation.DEFAULTS.gamma)),
      floorStartTokens: floorStart,
      // The plateau must sit above its onset, else the rise is a step.
      floorFullTokens: Math.max(
        floorStart + 1,
        ContextDegradation.finite(
          merged.floorFullTokens,
          ContextDegradation.DEFAULTS.floorFullTokens,
        ),
      ),
      floor: ContextDegradation.clamp(
        ContextDegradation.finite(merged.floor, ContextDegradation.DEFAULTS.floor),
      ),
      halfLifeMs: ContextDegradation.finite(
        merged.halfLifeMs,
        ContextDegradation.DEFAULTS.halfLifeMs,
      ),
    };
  }

  /**
   * The live-token onset where degradation starts for a window: whichever
   * of the length evidence and the fractional ramp begins first.
   */
  onset(contextWindow: number): number {
    const floorOnset =
      this.lengthCounts(contextWindow) ? this.opts.floorStartTokens : Number.POSITIVE_INFINITY;
    const rampOnset = ContextDegradation.known(contextWindow)
      ? contextWindow * this.opts.start
      : Number.POSITIVE_INFINITY;
    return Math.min(floorOnset, rampOnset);
  }

  /**
   * Whether the window is too large for occupancy to say anything the
   * research supports: either its size is unknown, or the fractional ramp
   * would not start until past the largest length the research measured.
   * Only then does the active-age term contribute.
   */
  unlimited(contextWindow: number): boolean {
    if (!ContextDegradation.known(contextWindow)) return true;
    return contextWindow * this.opts.start >= this.opts.floorFullTokens;
  }

  /**
   * Degradation pressure in `[0,1]` for a token count against the window,
   * with the active age of the live context when it is known.
   */
  pressure(tokens: number, contextWindow: number, activeMs?: number): number {
    const length = this.lengthEvidence(tokens);
    const floor = this.opts.floor * length;
    const ramp = this.occupancyRamp(tokens, contextWindow);
    const time = this.timeRamp(contextWindow, activeMs);
    const combined = 1 - (1 - floor) * (1 - ramp) * (1 - length * time);
    return ContextDegradation.clamp(combined);
  }

  /**
   * Whether any reason reads length evidence at all for a window: the floor
   * needs a plateau above zero, the age term needs its own switch on, and
   * both share the one onset. Keeping this in `onset` and `lengthEvidence`
   * together is what makes the two agree.
   */
  private lengthCounts(contextWindow: number): boolean {
    if (this.opts.floorStartTokens <= 0) return false;
    return this.opts.floor > 0 || this.timeCounts(contextWindow);
  }

  /** Whether the age term is switched on for this window. */
  private timeCounts(contextWindow: number): boolean {
    return this.opts.halfLifeMs > 0 && this.unlimited(contextWindow);
  }

  /**
   * Length evidence in `[0,1]`: 0 at `floorStartTokens`, 1 at the plateau.
   * Independent of `floor`, which only scales the floor's own contribution:
   * a zero floor must not also silence the age term that multiplies it.
   */
  private lengthEvidence(tokens: number): number {
    const { floorStartTokens, floorFullTokens } = this.opts;
    if (floorStartTokens <= 0) return 0;
    const span = Math.max(1, floorFullTokens - floorStartTokens);
    return ContextDegradation.clamp((ContextDegradation.count(tokens) - floorStartTokens) / span);
  }

  /** The uncapped fractional ramp toward the advertised window, in `[0,1]`. */
  private occupancyRamp(tokens: number, contextWindow: number): number {
    if (!ContextDegradation.known(contextWindow)) return 0;
    const start = contextWindow * this.opts.start;
    const full = Math.max(start, contextWindow * this.opts.full);
    const span = Math.max(1e-9, full - start);
    const ramp = Math.max(0, Math.min(1, (ContextDegradation.count(tokens) - start) / span));
    // Guard `Math.pow(0, 0)`: at/below the onset the pressure is 0 for any
    // exponent, including a clamped-to-zero negative one.
    if (ramp <= 0) return 0;
    return ContextDegradation.clamp(Math.pow(ramp, this.opts.gamma));
  }

  /**
   * Active-age ramp `1 - 2^(-a/T)`: 0 at no age, 1/2 at one half-life,
   * approaching 1 without reaching it. Applies only to unlimited windows.
   */
  private timeRamp(contextWindow: number, activeMs: number | undefined): number {
    if (!this.timeCounts(contextWindow)) return 0;
    if (typeof activeMs !== "number" || !Number.isFinite(activeMs) || activeMs <= 0) return 0;
    return ContextDegradation.clamp(1 - Math.pow(2, -activeMs / this.opts.halfLifeMs));
  }

  /** A window size is known when it is a positive finite number. */
  private static known(contextWindow: number): boolean {
    return Number.isFinite(contextWindow) && contextWindow > 0;
  }

  /** A token count cannot be negative, and an unknown one counts as none. */
  private static count(tokens: number): number {
    return Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  }

  /** The caller's number when it is finite, else the fallback. */
  private static finite(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
  }

  /** Clamped to `[0,1]`; a non-finite value claims nothing. */
  private static clamp(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }
}
