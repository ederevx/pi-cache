/**
 * pi-cache — probabilistic compaction pressure.
 *
 * One responsibility: turn live context size and cache economics into a
 * compaction probability that rises smoothly as the context grows, and
 * draw the Bernoulli decision. Raw token utilization is the base; the
 * cached share of the last request discounts it (cached reads are cheap,
 * so a warm context is less urgent) while a cold request raises it above
 * the raw utilization ("beyond the actual token cost"). The draw uses an
 * injected RNG so callers stay deterministic in tests.
 *
 * The sample is clamped into `[0, 1]` for the probability but the raw
 * pressure is reported unbounded, so a very cold, very large context can
 * exceed the nominal token threshold.
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
  /** Cold-context pressure premium (0 = no bonus); can push pressure > 1. */
  coldPremium: number;
  /** Uniform draw in `[0,1)`; injectable for tests. */
  random: () => number;
}

export interface PressureSample {
  tokens: number;
  contextWindow: number;
  reserveTokens: number;
  cacheRead: number;
  input: number;
}

export interface PressureVerdict {
  /** Unbounded pressure (`utilization * cache/cold factor`). */
  pressure: number;
  /** Clamped Bernoulli probability for this sample. */
  probability: number;
  /** The drawn decision. */
  fire: boolean;
}

const DEFAULT_OPTIONS: Omit<PressureOptions, "random"> = {
  start: 0.5,
  full: 0.85,
  gamma: 2,
  cacheDiscount: 0.5,
  coldPremium: 0.25,
};

export class CompactionPressure {
  private readonly opts: PressureOptions;

  constructor(opts: Partial<PressureOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts, random: opts.random ?? Math.random };
  }

  /** Utilization and cache/cold factor -> pressure, probability, draw. */
  sample(input: PressureSample): PressureVerdict {
    const usable = Math.max(1, input.contextWindow - input.reserveTokens);
    const utilization = Math.max(0, input.tokens / usable);
    const requestTokens = Math.max(0, input.input) + Math.max(0, input.cacheRead);
    const cacheShare = requestTokens > 0 ? Math.max(0, input.cacheRead) / requestTokens : 0;

    // Warm cache (large cacheShare) lowers urgency; cold cache raises it.
    const factor =
      (1 - this.opts.cacheDiscount * cacheShare) *
      (1 + this.opts.coldPremium * (1 - cacheShare));
    const pressure = utilization * factor;

    const span = Math.max(1e-9, this.opts.full - this.opts.start);
    const ramp = (pressure - this.opts.start) / span;
    const probability = Math.pow(Math.max(0, Math.min(1, ramp)), this.opts.gamma);
    return { pressure, probability, fire: this.opts.random() < probability };
  }
}
