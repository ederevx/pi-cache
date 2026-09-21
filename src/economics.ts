/**
 * pi-cache — expected-cost compaction economics.
 *
 * One responsibility: decide whether compacting the current prefix is
 * cheaper than continuing with it, over an expected horizon of future
 * requests, and express the outcome as a `[0,1]` pressure. This replaces
 * the old "how full is the window" ramp: occupancy cancels out of the
 * comparison, so the trigger is cache economics (write amortization,
 * read rate, TTL coldness) plus context degradation — not a
 * token count. All costs are in the model's per-million-token units; only
 * their ratio matters. Owns only its options; no mutable state.
 */

export interface CostRates {
  /** Input (cache-miss) rate per million tokens. */
  input: number;
  /** Cache-read (hit) rate per million tokens. */
  cacheRead: number;
  /** Cache-write rate per million tokens (0 = provider charges none). */
  cacheWrite: number;
}

export interface EconomicsInput {
  /** Live context tokens. */
  tokens: number;
  /** Cache coldness in `[0,1]`: 0 warm (reads hit), 1 cold (reads miss). */
  coldness: number;
  /** One compaction's summarizer cost in the same per-million units. */
  summaryCost: number;
}

export interface EconomicsCosts {
  /** Expected price of continuing without compaction. */
  continueCost: number;
  /** Expected price of compacting now, then continuing. */
  compactCost: number;
  /** `continueCost - compactCost`; positive means compaction wins. */
  savings: number;
  /** Expected remaining requests the comparison spans. */
  horizon: number;
}

export interface CacheEconomicsOptions {
  /** Idle per-turn chance another request arrives; sets the horizon. */
  continuationProbability: number;
  /** Cap on the expected-request horizon (bounds the comparison). */
  maxRequests: number;
  /** Fraction of the context compaction retains (estimates the rewrite). */
  keepFraction: number;
}

export class CacheEconomics {
  private static readonly DEFAULTS: CacheEconomicsOptions = {
    continuationProbability: 0.15,
    maxRequests: 8,
    keepFraction: 0.2,
  };

  private readonly opts: CacheEconomicsOptions;

  constructor(opts: Partial<CacheEconomicsOptions> = {}) {
    this.opts = { ...CacheEconomics.DEFAULTS, ...opts };
  }

  /**
   * Expected remaining requests the current prefix still matters for:
   * `1 / (1 - continuationProbability)`, clamped to `[1, maxRequests]`.
   */
  horizon(): number {
    const probability = Math.max(0, Math.min(0.99, this.opts.continuationProbability));
    const expected = 1 / (1 - probability);
    return Math.max(1, Math.min(Math.max(1, this.opts.maxRequests), expected));
  }

  /** The continue-vs-compact costs for one sample. */
  costs(rates: CostRates, input: EconomicsInput): EconomicsCosts {
    const horizon = this.horizon();
    const tokens = Math.max(0, input.tokens);
    const kept = Math.max(0, Math.min(1, this.opts.keepFraction)) * tokens;
    const readRate = this.readRate(rates, input.coldness);
    const continueCost = this.price(readRate, tokens) * horizon;
    const compactCost =
      this.price(this.writeRate(rates), kept) + this.price(readRate, kept) * horizon + input.summaryCost;
    return { continueCost, compactCost, savings: continueCost - compactCost, horizon };
  }

  /** Fraction of the continuing cost that compaction avoids, in `[0,1]`. */
  pressure(rates: CostRates, input: EconomicsInput): number {
    const { continueCost, savings } = this.costs(rates, input);
    if (continueCost <= 0) return 0;
    return Math.max(0, Math.min(1, savings / continueCost));
  }

  /**
   * The read rate actually paid: an interpolated mix of the warm hit rate
   * and the cold miss rate, so a fully cold prefix pays the input rate.
   */
  private readRate(rates: CostRates, coldness: number): number {
    const cold = Math.max(0, Math.min(1, coldness));
    return cold * rates.input + (1 - cold) * rates.cacheRead;
  }

  /** Providers that charge no write premium (cacheWrite 0) bill writes as input. */
  private writeRate(rates: CostRates): number {
    return rates.cacheWrite > 0 ? rates.cacheWrite : rates.input;
  }

  /** Price one token count at a per-million rate. */
  private price(rate: number, tokens: number): number {
    return (rate * tokens) / 1_000_000;
  }
}