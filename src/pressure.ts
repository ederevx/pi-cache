/**
 * pi-cache — compaction pressure.
 *
 * One responsibility: combine the two independent reasons to compact —
 * context degradation as the window is approached and the expected cost
 * of continuing versus rewriting the prefix — into a single `[0,1]`
 * pressure, map it to a probability, and draw the Bernoulli decision.
 *
 * The pressure is NOT a context-window occupancy ramp. Economics cancels
 * occupancy out of the comparison (see economics.ts), so a warm prefix with
 * few expected requests stays at zero even when large, while a cold prefix
 * or one past the degradation onset rises. The two reasons are combined by
 * inclusion-exclusion (either suffices). The draw uses an injected RNG so
 * callers stay deterministic in tests.
 */

import { CacheEconomics, type CostRates } from "./economics.ts";
import { ContextDegradation } from "./context-degradation.ts";

export interface PressureOptions {
  /** Expected-cost model that owns the economics pressure. */
  economics: CacheEconomics;
  /** Context-degradation model that owns the occupancy pressure. */
  degradation: ContextDegradation;
  /** Combined pressure at/below which the probability is 0 (deadband). */
  start: number;
  /** Combined pressure at/above which the probability is 1. */
  full: number;
  /** Ramp exponent (>1 biases toward the top). */
  gamma: number;
  /** Uniform draw in `[0,1)`; injectable for tests. */
  random: () => number;
}

export interface PressureSample {
  tokens: number;
  contextWindow: number;
  /** Coldness in `[0,1]`: 0 = fully warm, 1 = fully cold. */
  coldness?: number;
  /** Model cost rates; absent means economics is unavailable. */
  rates?: CostRates;
  /** One compaction's summarizer cost (0 with fast compaction). */
  summaryCost?: number;
  /** Fallback warmth inputs when `coldness` is absent. */
  cacheRead?: number;
  input?: number;
}

export interface PressureVerdict {
  /** Combined pressure in `[0,1]` (`max`-style either-reason blend). */
  pressure: number;
  /** The context-degradation component of the pressure. */
  degradation: number;
  /** The expected-cost component of the pressure. */
  economics: number;
  /** Clamped Bernoulli probability for this sample. */
  probability: number;
  /** The drawn decision. */
  fire: boolean;
}

export class CompactionPressure {
  private static readonly DEFAULTS = {
    start: 0.1,
    full: 0.6,
    gamma: 2,
  };

  private readonly opts: PressureOptions;

  constructor(opts: Partial<PressureOptions> = {}) {
    this.opts = {
      ...CompactionPressure.DEFAULTS,
      ...opts,
      economics: opts.economics ?? new CacheEconomics(),
      degradation: opts.degradation ?? new ContextDegradation(),
      random: opts.random ?? Math.random,
    };
  }

  /** Compose the pressure and probability into the drawn verdict. */
  sample(input: PressureSample): PressureVerdict {
    const degradation = this.degradationFor(input);
    const economics = this.economicsFor(input);
    const pressure = CompactionPressure.combine(degradation, economics);
    const probability = this.probabilityFor(pressure);
    return { pressure, degradation, economics, probability, fire: this.opts.random() < probability };
  }

  /** Context-degradation pressure from the active model's onset. */
  private degradationFor(input: PressureSample): number {
    return this.opts.degradation.pressure(input.tokens, input.contextWindow);
  }

  /** Expected-cost pressure when rates are known, else 0. */
  private economicsFor(input: PressureSample): number {
    if (!input.rates) return 0;
    return this.opts.economics.pressure(input.rates, {
      tokens: input.tokens,
      coldness: this.coldness(input),
      summaryCost: Math.max(0, input.summaryCost ?? 0),
    });
  }

  /** Either reason suffices: `1 - (1 - degradation)(1 - economics)`. */
  private static combine(degradation: number, economics: number): number {
    return 1 - (1 - degradation) * (1 - economics);
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

  /** Ramp combined pressure into a clamped `[0,1]` Bernoulli probability. */
  private probabilityFor(pressure: number): number {
    const span = Math.max(1e-9, this.opts.full - this.opts.start);
    const ramp = (pressure - this.opts.start) / span;
    return Math.pow(Math.max(0, Math.min(1, ramp)), this.opts.gamma);
  }

  private static clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
  }
}