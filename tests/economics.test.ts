/**
 * pi-cache — expected-cost economics tests.
 * The compaction decision must compare continuing against rewriting the
 * prefix over an expected horizon, so occupancy cancels out of the ratio
 * and only cache rates, coldness, horizon, and kept fraction matter.
 */

import { test, assert, assertEq } from "./harness.ts";
import { CacheEconomics } from "../src/economics.ts";

const rates = { input: 3, cacheRead: 0.3, cacheWrite: 3.75 };

test("economics: the horizon is 1/(1-p) capped at maxRequests", () => {
  assertEq(new CacheEconomics({ continuationProbability: 0.5 }).horizon(), 2);
  assertEq(
    new CacheEconomics({ continuationProbability: 0.9, maxRequests: 4 }).horizon(),
    4,
    "capped",
  );
  assertEq(new CacheEconomics({ continuationProbability: 0.99 }).horizon(), 8, "near-1 is capped");
  assertEq(new CacheEconomics({ continuationProbability: 0 }).horizon(), 1, "at least one");
});

test("economics: a cold prefix saves by compacting", () => {
  const e = new CacheEconomics();
  const costs = e.costs(rates, { tokens: 120_000, coldness: 1, summaryCost: 0 });
  assert(costs.savings > 0, `savings ${costs.savings}`);
  assert(e.pressure(rates, { tokens: 120_000, coldness: 1, summaryCost: 0 }) > 0.5);
});

test("economics: a warm low-horizon prefix loses", () => {
  const e = new CacheEconomics({ continuationProbability: 0.15 });
  const costs = e.costs(rates, { tokens: 120_000, coldness: 0, summaryCost: 0 });
  assert(costs.compactCost > costs.continueCost, "rewrite is not yet amortized");
  assertEq(e.pressure(rates, { tokens: 120_000, coldness: 0, summaryCost: 0 }), 0);
});

test("economics: occupancy cancels out of the ratio", () => {
  const e = new CacheEconomics();
  const at = (tokens: number) => e.pressure(rates, { tokens, coldness: 1, summaryCost: 0 });
  assert(Math.abs(at(20_000) - at(80_000)) < 1e-9, "cost ratio is flat in token count");
  assert(at(20_000) > 0, "still pressures");
});

test("economics: a summarizer cost delays the trigger", () => {
  const e = new CacheEconomics();
  const free = e.pressure(rates, { tokens: 120_000, coldness: 1, summaryCost: 0 });
  const paid = e.pressure(rates, { tokens: 120_000, coldness: 1, summaryCost: 500 });
  assert(free > 0, "the free path pressures");
  assert(paid < free, "a paid summarizer must not pressure more");
});

test("economics: zero tokens and zero rates yield no pressure", () => {
  const e = new CacheEconomics();
  assertEq(e.pressure(rates, { tokens: 0, coldness: 1, summaryCost: 0 }), 0);
  assertEq(
    e.pressure({ input: 0, cacheRead: 0, cacheWrite: 0 }, { tokens: 120_000, coldness: 1, summaryCost: 0 }),
    0,
  );
});

test("economics: non-finite options fall back safely", () => {
  const e = new CacheEconomics({
    continuationProbability: Number.NaN,
    maxRequests: Number.POSITIVE_INFINITY,
    keepFraction: Number.NaN,
  });
  assertEq(e.horizon(), 1 / (1 - 0.15), "continuation falls back");
  const pressure = e.pressure(rates, { tokens: 120_000, coldness: 1, summaryCost: 0 });
  assert(Number.isFinite(pressure) && pressure >= 0 && pressure <= 1, `bounded ${pressure}`);
});