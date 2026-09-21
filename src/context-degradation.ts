/**
 * pi-cache — context degradation.
 *
 * One responsibility: map context occupancy onto a `[0,1]` degradation
 * pressure. Long-context answer quality degrades below the advertised
 * window (RULER, NoLiMa, "Lost in the Middle"), and where that degradation
 * begins is model- and task-dependent, so this is the tunable onset of the
 * degradation model rather than the primary compaction driver. Owns only
 * its options; no mutable state.
 */

export interface ContextDegradationOptions {
  /** Occupancy at/below which degradation pressure is 0. */
  start: number;
  /** Occupancy at/above which degradation pressure is 1. */
  full: number;
  /** Curve exponent (>1 keeps pressure near 0 through the onset). */
  gamma: number;
}

export class ContextDegradation {
  private static readonly DEFAULTS = {
    start: 0.5,
    full: 0.85,
    gamma: 2,
  };

  private readonly opts: ContextDegradationOptions;

  constructor(opts: Partial<ContextDegradationOptions> = {}) {
    this.opts = { ...ContextDegradation.DEFAULTS, ...opts };
  }

  /** Degradation pressure in `[0,1]` for a token count against the window. */
  pressure(tokens: number, contextWindow: number): number {
    const occupancy = Math.max(0, tokens) / Math.max(1, contextWindow);
    const span = Math.max(1e-9, this.opts.full - this.opts.start);
    const ramp = (occupancy - this.opts.start) / span;
    return Math.pow(Math.max(0, Math.min(1, ramp)), this.opts.gamma);
  }
}