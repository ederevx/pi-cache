/**
 * pi-cache — context degradation.
 *
 * One responsibility: map context occupancy onto a `[0,1]` degradation
 * pressure. Long-context answer quality degrades well below the advertised
 * window (RULER: only ~4 of 13 models claiming ≥32K hold up at 32K; NoLiMa:
 * effective lengths as low as 2K for models claiming 128K; Chroma "Context
 * Rot": quality falls as input grows even on simple tasks), and effective
 * context does not grow with the advertised window. The onset is therefore
 * each occupancy fraction capped at an absolute token budget, so a very
 * large window (1M) still compacts around the frontier ~200K class the
 * peer harnesses use (Claude Code ~200K effective, Codex/OpenCode ~90% of
 * the window) instead of waiting for a fraction of a window quality never
 * survives. Owns only its options; no mutable state.
 */

export interface ContextDegradationOptions {
  /** Occupancy at/below which degradation pressure is 0 (fraction). */
  start: number;
  /** Occupancy at/above which degradation pressure is 1 (fraction). */
  full: number;
  /** Curve exponent (>1 keeps pressure near 0 through the onset). */
  gamma: number;
  /** Absolute token cap on the onset start (<=0 disables the cap). */
  startTokens: number;
  /** Absolute token cap on saturation (<=0 disables the cap). */
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

  /**
   * The onset in absolute tokens for a window: each occupancy fraction
   * capped at its token budget. Effective context does not scale with the
   * advertised window, so the cap keeps a 1M-window model from waiting for
   * 500K-850K before quality pressure starts. `full` is never below `start`.
   */
  onset(contextWindow: number): { start: number; full: number } {
    const window = Math.max(1, contextWindow);
    const start = ContextDegradation.capped(this.opts.start * window, this.opts.startTokens);
    const full = Math.max(start, ContextDegradation.capped(this.opts.full * window, this.opts.fullTokens));
    return { start, full };
  }

  /** Degradation pressure in `[0,1]` for a token count against the window. */
  pressure(tokens: number, contextWindow: number): number {
    const { start, full } = this.onset(contextWindow);
    const span = Math.max(1e-9, full - start);
    const ramp = Math.max(0, Math.min(1, (Math.max(0, tokens) - start) / span));
    // Guard `Math.pow(0, 0)`: at/below the onset the pressure is 0 for any
    // exponent, including a clamped-to-zero negative one.
    if (ramp <= 0) return 0;
    return Math.max(0, Math.min(1, Math.pow(ramp, this.opts.gamma)));
  }

  /** A positive finite cap bounds the onset; anything else leaves it uncapped. */
  private static capped(tokens: number, cap: number): number {
    return Number.isFinite(cap) && cap > 0 ? Math.min(tokens, cap) : tokens;
  }
}
