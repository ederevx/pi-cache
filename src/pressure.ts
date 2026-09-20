/**
 * pi-cache — probabilistic compaction pressure.
 *
 * One responsibility: turn live context size and cache coldness into a
 * compaction probability that rises smoothly as the context grows and the
 * cache cools, and draw the Bernoulli decision.
 *
 * - `utilization` (tokens / usable window) is the base ramp.
 * - `coldness` in [0,1] (0 warm, 1 cold) scales it: a warm cache is
 *   discounted (cached reads are cheap, so keeping it is fine) and a cold
 *   cache is premium-loaded ("beyond the actual token cost").
 * - When `coldness` is absent the sample falls back to the last request's
 *   cached share (`1 - cacheRead / (cacheRead + input)`).
 *
 * The draw uses an injected RNG so callers stay deterministic in tests.
 */

export interface PressureOptions {
  /** Utilization at/below which the probability is 0. */
  start: number;
  /** Utilization at/above which the probability is 1. */
  full: number;
  /** Curve exponent (>1 biases the ramp toward the top). */
  gamma: number;
  /** Warm-cache pressure discount in `[0,1]` (1 = ignore cached tokens). */
  cacheDiscount: number;
  /** Cold-cache pressure premium (0 = no bonus); can push pressure > 1. */
  coldPremium: number;
  /** Uniform draw in `[0,1)`; injectable for tests. */
  random: () => number;
}

export interface PressureSample {
  tokens: number;
  contextWindow: number;
  reserveTokens: number;
  /** Coldness in `[0,1]`: 0 = fully warm, 1 = fully cold (preferred). */
  coldness?: number;
  /**
   * Fast compaction is active: the override is prefix-stable, so the warm
   * discount must not suppress the token ramp. `true` uses a neutral
   * factor of 1 (no discount, no premium).
   */
  neutral?: boolean;
  /** Fallback warmth inputs when `coldness` is absent. */
  cacheRead?: number;
  input?: number;
}

export interface PressureVerdict {
  /** Unbounded pressure (`utilization * coldness factor`). */
  pressure: number;
  /** Clamped Bernoulli probability for this sample. */
  probability: number;
  /** The drawn decision. */
  fire: boolean;
}

export class CompactionPressure {
  private static readonly DEFAULTS: Omit<PressureOptions, "random"> = {
    start: 0.5,
    full: 0.85,
    gamma: 2,
    cacheDiscount: 0.5,
    coldPremium: 0.25,
  };

  private readonly opts: PressureOptions;

  constructor(opts: Partial<PressureOptions> = {}) {
    this.opts = {
      ...CompactionPressure.DEFAULTS,
      ...opts,
      random: opts.random ?? Math.random,
    };
  }

  /** Compose the pressure and probability into the drawn verdict. */
  sample(input: PressureSample): PressureVerdict {
    const pressure = this.pressureFor(input);
    const probability = this.probabilityFor(pressure);
    return { pressure, probability, fire: this.opts.random() < probability };
  }

  /** Utilization and coldness factor -> raw pressure. */
  private pressureFor(input: PressureSample): number {
    const factor = input.neutral
      ? 1
      : this.coldnessFactor(this.coldness(input));
    return this.utilization(input) * factor;
  }

  /** Context tokens as a fraction of the usable window. */
  private utilization(input: PressureSample): number {
    const usable = Math.max(1, input.contextWindow - input.reserveTokens);
    return Math.max(0, input.tokens / usable);
  }

  /** Explicit coldness when given, else derived from the cached share. */
  private coldness(input: PressureSample): number {
    if (typeof input.coldness === "number" && Number.isFinite(input.coldness)) {
      return CompactionPressure.clamp(input.coldness);
    }
    const cacheRead = Math.max(0, input.cacheRead ?? 0);
    const fresh = Math.max(0, input.input ?? 0);
    const requestTokens = cacheRead + fresh;
    return requestTokens > 0 ? 1 - cacheRead / requestTokens : 1;
  }

  /** Warm cache lowers urgency; cold cache raises it above raw utilization. */
  private coldnessFactor(coldness: number): number {
    return (
      (1 - this.opts.cacheDiscount * (1 - coldness)) *
      (1 + this.opts.coldPremium * coldness)
    );
  }

  /** Ramp pressure into a clamped `[0,1]` Bernoulli probability. */
  private probabilityFor(pressure: number): number {
    const span = Math.max(1e-9, this.opts.full - this.opts.start);
    const ramp = (pressure - this.opts.start) / span;
    return Math.pow(Math.max(0, Math.min(1, ramp)), this.opts.gamma);
  }

  private static clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
  }
}