/**
 * pi-cache — compaction-pressure tests.
 * Probability must be 0 at/below the start utilization, rise monotonically
 * with context tokens, and reflect cache economics: a warm request is
 * discounted while a cold request is premium-pressured (pressure may exceed
 * raw utilization). The Bernoulli draw uses the injected RNG.
 */

import { test, assert, assertEq } from "./harness.ts";
import { CompactionPressure } from "../src/pressure.ts";

function pressure(random: () => number = () => 0) {
  return new CompactionPressure({ random });
}

const cold = { cacheRead: 0, input: 1000 };
const warm = { cacheRead: 1000, input: 0 };

test("pressure: zero below the start utilization", () => {
  const p = pressure();
  const { probability, fire } = p.sample({
    tokens: 10_000,
    contextWindow: 100_000,
    reserveTokens: 0,
    ...cold,
  });
  assertEq(probability, 0);
  assertEq(fire, false);
});

test("pressure: probability rises monotonically with tokens", () => {
  const p = pressure();
  const at = (tokens: number) =>
    p.sample({ tokens, contextWindow: 200_000, reserveTokens: 0, ...cold }).probability;
  const a = at(100_000);
  const b = at(120_000);
  const c = at(140_000);
  assert(a < b, `expected ${a} < ${b}`);
  assert(b < c, `expected ${b} < ${c}`);
  assertEq(c, 1, "saturates at the full utilization");
});

test("pressure: warm cache is discounted below a cold request", () => {
  const p = pressure();
  const sample = (tx: { cacheRead: number; input: number }) =>
    p.sample({ tokens: 160_000, contextWindow: 200_000, reserveTokens: 0, ...tx });
  const coldV = sample(cold);
  const warmV = sample(warm);
  assert(warmV.pressure < coldV.pressure, "warm pressure should be lower");
  assert(warmV.probability <= coldV.probability, "warm probability should not exceed cold");
});

test("pressure: a cold request can exceed raw token utilization", () => {
  const p = pressure();
  const v = p.sample({
    tokens: 160_000,
    contextWindow: 200_000,
    reserveTokens: 0,
    ...cold,
  });
  assert(v.pressure > 0.8, `cold pressure ${v.pressure} should exceed 0.8 utilization`);
});

test("pressure: reserve tokens shrink the usable window", () => {
  const p = pressure();
  const withReserve = p.sample({
    tokens: 100_000,
    contextWindow: 200_000,
    reserveTokens: 100_000,
    ...cold,
  });
  const without = p.sample({
    tokens: 100_000,
    contextWindow: 200_000,
    reserveTokens: 0,
    ...cold,
  });
  assert(withReserve.pressure > without.pressure, "reserve raises utilization");
});

test("pressure: the injected RNG drives the draw", () => {
  const always = pressure(() => 0);
  const never = pressure(() => 0.999999);
  const sample = { tokens: 120_000, contextWindow: 200_000, reserveTokens: 0, ...cold };
  assertEq(always.sample(sample).fire, true);
  assertEq(never.sample(sample).fire, false);
});

test("pressure: explicit coldness scales pressure", () => {
  const p = pressure();
  const at = (coldness: number) =>
    p.sample({ tokens: 120_000, contextWindow: 200_000, reserveTokens: 0, coldness });
  assert(at(1).pressure > at(0).pressure, "cold pressure above warm");
  assert(
    at(0.5).pressure > at(0).pressure && at(0.5).pressure < at(1).pressure,
    "pressure is monotone in coldness",
  );
});

test("pressure: coldness is clamped to [0,1]", () => {
  const p = pressure();
  const at = (coldness: number) =>
    p.sample({ tokens: 120_000, contextWindow: 200_000, reserveTokens: 0, coldness }).pressure;
  assertEq(at(-5), at(0));
  assertEq(at(5), at(1));
});

test("pressure: neutral ignores the warm discount", () => {
  const p = pressure();
  const warm = { tokens: 160_000, contextWindow: 200_000, reserveTokens: 0, coldness: 0 };
  const discounted = p.sample(warm);
  const neutral = p.sample({ ...warm, neutral: true });
  assert(neutral.pressure > discounted.pressure, "neutral is not discounted");
  assertEq(neutral.pressure, 0.8, "neutral pressure is plain utilization");
});
