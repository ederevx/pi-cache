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
 *    finds the decline non-uniform and strongly model- and task-dependent,
 *    and "Context Length Alone Hurts" (arXiv 2510.05381) shows length alone
 *    costs 13.9-85% even with perfect retrieval. So a token count is
 *    evidence of degradation across a *band*: it starts at the larger of
 *    `floorStartTokens` and `floorStartFraction` of the window, and
 *    plateaus at the larger of `floorFullTokens` and `floorFullFraction` of
 *    it, at height `floor` (default 0.5, clamped to `[0,1]`). The absolute
 *    ends are the lengths the 2024-25 evidence measured, so they stay
 *    minimums: no window can make degradation start earlier than they do.
 *    A wider window scales both ends up: the 1M-window evaluations have
 *    points at 128K and at 1M, where RULER-1M scores the top instruct models
 *    at 87.7-94.8 on its synthetic tasks and their base counterparts at
 *    51.2-76.8, Gemini 2.5 reports 1M scores well below its 128K ones, and
 *    ATLAS finds a 128K score cannot tell a model stable through 1M from one
 *    that cliffs just after 128K. Either way the band is a *minimum* on the
 *    pressure, never a
 *    ceiling, because which count is the real onset differs per model. Only
 *    an explicit `floor = 1` lets length alone saturate.
 *  - *Occupancy.* The fractional `start`/`full` ramp toward the advertised
 *    window is what carries the pressure the rest of the way to the window
 *    limit. It is unchanged and uncapped: a window small enough to be
 *    trusted keeps exactly the curve it had.
 *
 * For a window whose size is unknown, or so large that the fractional ramp
 * cannot start until after the lengths the research measured, neither of
 * those says anything useful, and *active time* takes over. Content
 * accumulated over hours degrades more than the same content accumulated
 * over minutes, discounted by a half-life so the term saturates slowly
 * instead of becoming a cliff at some age. Time raises the height of the
 * band's plateau instead of adding a second reason: `L * (floor + (1 -
 * floor) * time)`. Both terms come from the same length evidence, so
 * treating them as independent would count it twice. The plateau height and
 * the fractional ramp combine by inclusion-exclusion, the same
 * either-reason-suffices rule the pressure blend already uses, which keeps
 * the result bounded in `[0,1]` and monotone in both arguments. Owns only its
 * options; no mutable state.
 */

export interface ContextDegradationOptions {
  /** Occupancy fraction at/below which the fractional ramp is 0. */
  start: number;
  /** Occupancy fraction at/above which the fractional ramp is 1. */
  full: number;
  /** Curve exponent (>1 keeps the fractional ramp near 0 through the onset). */
  gamma: number;
  /** Absolute token count where the length band starts (<=0 disables it). */
  floorStartTokens: number;
  /** Absolute token count where the length band plateaus. */
  floorFullTokens: number;
  /** Window fraction the band starts at when that is later ([0,1]). */
  floorStartFraction: number;
  /** Window fraction the band plateaus at when that is later. */
  floorFullFraction: number;
  /** Band plateau height in `[0,1]`: the most a token count alone can claim. */
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
    // onset for the band's absolute end.
    floorStartTokens: 32_768,
    // 131 072: the largest length the 2024-25 evidence reaches (Databricks at
    // 128K, and NoLiMa's appendix at 64K-128K for the two models it extends
    // that far), and so the plateau's absolute end.
    floorFullTokens: 131_072,
    // 1/8 = 131 072 / 1 048 576, the 128K point of the 1M-window reports, and
    // also 32 768 / 262 144, so windows up to 256Ki keep the absolute onset.
    floorStartFraction: 1 / 8,
    // Unvalidated policy default, as the plateau height is: the latest plateau
    // that leaves windows below 262 144 on the absolute band. The evidence
    // only bounds it, since no cited model stays flat to its advertised limit.
    floorFullFraction: 0.5,
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
    const startFraction = ContextDegradation.clamp(
      ContextDegradation.finite(
        merged.floorStartFraction,
        ContextDegradation.DEFAULTS.floorStartFraction,
      ),
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
      floorStartFraction: startFraction,
      // The plateau cannot start at a window fraction the band's onset has not
      // reached, so it is raised to the onset's fraction rather than inverted.
      floorFullFraction: Math.max(
        startFraction,
        ContextDegradation.clamp(
          ContextDegradation.finite(
            merged.floorFullFraction,
            ContextDegradation.DEFAULTS.floorFullFraction,
          ),
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
      this.lengthCounts(contextWindow) ? this.bandStart(contextWindow) : Number.POSITIVE_INFINITY;
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
    const length =
      this.lengthEvidence(tokens, contextWindow) * this.plateau(contextWindow, activeMs);
    const ramp = this.occupancyRamp(tokens, contextWindow);
    return ContextDegradation.clamp(1 - (1 - length) * (1 - ramp));
  }

  /**
   * Whether any reason reads the band at all for a window: the band needs a
   * height above zero, the age term needs its own switch on, and both share
   * the one onset. Keeping this in `onset` and `lengthEvidence` together is
   * what makes the two agree.
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
   * Where the length band starts: its absolute onset, or the window's share
   * of it when that is later, so a large window never starts it earlier.
   */
  private bandStart(contextWindow: number): number {
    const scaled = ContextDegradation.known(contextWindow)
      ? this.opts.floorStartFraction * contextWindow
      : 0;
    return Math.max(this.opts.floorStartTokens, scaled);
  }

  /**
   * Where the length band plateaus: its absolute plateau, or the window's
   * share of it when that is later.
   */
  private bandFull(contextWindow: number): number {
    const scaled = ContextDegradation.known(contextWindow)
      ? this.opts.floorFullFraction * contextWindow
      : 0;
    return Math.max(this.opts.floorFullTokens, scaled);
  }

  /**
   * Length evidence in `[0,1]`: 0 at the band's start, 1 at its plateau.
   * Independent of `floor`, which only scales the band's own contribution:
   * a zero floor must not also silence the age term that raises it.
   */
  private lengthEvidence(tokens: number, contextWindow: number): number {
    if (this.opts.floorStartTokens <= 0) return 0;
    const start = this.bandStart(contextWindow);
    const span = Math.max(1, this.bandFull(contextWindow) - start);
    return ContextDegradation.clamp((ContextDegradation.count(tokens) - start) / span);
  }

  /**
   * The band's plateau height: `floor` with no active age, rising toward 1 by
   * the half-life, so a long session makes the same length claim more.
   */
  private plateau(contextWindow: number, activeMs: number | undefined): number {
    const { floor } = this.opts;
    return floor + (1 - floor) * this.timeRamp(contextWindow, activeMs);
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
