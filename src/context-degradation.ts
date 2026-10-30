/**
 * pi-cache — context degradation.
 *
 * One responsibility: map context occupancy onto a `[0,1]` degradation
 * pressure. Long-context answer quality degrades below the advertised
 * window (RULER, NoLiMa, "Lost in the Middle"), and where that degradation
 * begins is model- and task-dependent, so this is the tunable onset of the
 * degradation model rather than the primary compaction driver. Each onset
 * fraction is additionally capped at an absolute token budget, because a
 * large advertised window otherwise postpones quality pressure far past the
 * context a model actually holds up on. Owns only its options; no mutable
 * state.
 */

export interface ContextDegradationOptions {
  /** Occupancy at/below which degradation pressure is 0. */
  start: number;
  /** Occupancy at/above which degradation pressure is 1. */
  full: number;
  /** Curve exponent (>1 keeps pressure near 0 through the onset). */
  gamma: number;
  /** Absolute token cap on the onset start (<=0 leaves it uncapped). */
  startTokens: number;
  /** Absolute token cap on saturation (<=0 leaves it uncapped). */
  fullTokens: number;
}

export class ContextDegradation {
  private static readonly DEFAULTS = {
    start: 0.5,
    full: 0.85,
    gamma: 2,
    startTokens: 100_000,
    fullTokens: 200_000,
  };

  private readonly opts: ContextDegradationOptions;

  constructor(opts: Partial<ContextDegradationOptions> = {}) {
    this.opts = {
      ...ContextDegradation.DEFAULTS,
      ...opts,
      // A negative exponent would invert the ramp (and make a zero ramp
      // Infinity), so the exponent is clamped non-negative.
      gamma: Math.max(0, opts.gamma ?? ContextDegradation.DEFAULTS.gamma),
    };
  }

  /** The live-token onset where degradation starts for a window. */
  onset(contextWindow: number): number {
    return this.bounds(contextWindow).start;
  }

  /** Degradation pressure in `[0,1]` for a token count against the window. */
  pressure(tokens: number, contextWindow: number): number {
    const { start, full } = this.bounds(contextWindow);
    const span = Math.max(1e-9, full - start);
    const ramp = Math.max(0, Math.min(1, (Math.max(0, tokens) - start) / span));
    // Guard `Math.pow(0, 0)`: at/below the onset the pressure is 0 for any
    // exponent, including a clamped-to-zero negative one.
    if (ramp <= 0) return 0;
    return Math.max(0, Math.min(1, Math.pow(ramp, this.opts.gamma)));
  }

  /** The onset and saturation points in absolute tokens for a window. */
  private bounds(contextWindow: number): { start: number; full: number } {
    const window = Math.max(1, contextWindow);
    const start = ContextDegradation.capped(window * this.opts.start, this.opts.startTokens);
    const full = Math.max(start, ContextDegradation.capped(window * this.opts.full, this.opts.fullTokens));
    return { start, full };
  }

  /** A positive finite cap bounds the onset; anything else leaves it uncapped. */
  private static capped(tokens: number, cap: number): number {
    return Number.isFinite(cap) && cap > 0 ? Math.min(tokens, cap) : tokens;
  }
}