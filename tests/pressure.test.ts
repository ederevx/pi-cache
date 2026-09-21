/**
 * pi-cache — compaction-pressure tests.
 * Pressure must come from two independent reasons — context degradation
 * and expected-cost cache economics — combined so either suffices. It must
 * NOT be a context-window occupancy ramp: with economics available and the
 * onset still at zero, pressure is flat across token counts. The Bernoulli
 * draw uses the injected RNG.
 */

import { test, assert, assertEq } from "./harness.ts";
import { CompactionPressure } from "../src/pressure.ts";
import { CacheEconomics } from "../src/economics.ts";
import { ContextDegradation } from "../src/context-degradation.ts";

const rates = { input: 3, cacheRead: 0.3, cacheWrite: 3.75 };

function pressure(random: () => number = () => 0) {
  return new CompactionPressure({ random });
}

test("pressure: zero below the degradation onset and without rates", () => {
  const p = pressure();
  const verdict = p.sample({ tokens: 20_000, contextWindow: 200_000, coldness: 1 });
  assertEq(verdict.pressure, 0);
  assertEq(verdict.probability, 0);
  assertEq(verdict.fire, false);
});

test("pressure: degradation alone rises with occupancy", () => {
  const p = pressure();
  const at = (tokens: number) => p.sample({ tokens, contextWindow: 200_000 }).degradation;
  assertEq(at(100_000), 0, "at the onset start");
  assert(at(120_000) > 0, "past the onset start");
  assert(at(170_000) > at(120_000), "rising through the onset");
  assertEq(at(200_000), 1, "saturates at the onset full");
});

test("pressure: economics does not scale with token count", () => {
  const p = pressure();
  // Both occupancies stay below the 0.5 degradation onset, so only economics varies.
  const small = p.sample({ tokens: 20_000, contextWindow: 200_000, coldness: 1, rates });
  const large = p.sample({ tokens: 80_000, contextWindow: 200_000, coldness: 1, rates });
  assert(small.economics > 0, "a cold prefix pressures");
  assertEq(small.economics, large.economics, "occupancy cancels out of the cost ratio");
  assertEq(small.degradation, 0, "still below the onset");
  assertEq(large.degradation, 0, "still below the onset");
});

test("pressure: a warm low-horizon prefix does not pressure", () => {
  const p = pressure();
  const verdict = p.sample({ tokens: 120_000, contextWindow: 200_000, coldness: 0, rates });
  assertEq(verdict.economics, 0, "a warm prefix has not amortized its rewrite");
  assert(verdict.pressure > 0, "only the small degradation component remains");
  assertEq(verdict.probability, 0, "below the deadband");
});

test("pressure: a cold prefix pressures through economics", () => {
  const p = pressure();
  const verdict = p.sample({ tokens: 120_000, contextWindow: 200_000, coldness: 1, rates });
  assert(verdict.economics > 0.5, `cold economics ${verdict.economics}`);
  assert(verdict.pressure > 0.6, `combined ${verdict.pressure}`);
  assertEq(verdict.probability, 1, "saturates the ramp");
});

test("pressure: pressure is monotone in coldness", () => {
  const p = pressure();
  const at = (coldness: number) =>
    p.sample({ tokens: 120_000, contextWindow: 200_000, coldness, rates }).pressure;
  assert(at(1) > at(0.5) && at(0.5) > at(0), "colder means more pressure");
});

test("pressure: explicit coldness is clamped to [0,1]", () => {
  const p = pressure();
  const at = (coldness: number) =>
    p.sample({ tokens: 120_000, contextWindow: 200_000, coldness, rates }).pressure;
  assertEq(at(-5), at(0));
  assertEq(at(5), at(1));
});

test("pressure: the injected RNG drives the draw", () => {
  const always = new CompactionPressure({ start: 0, full: 0.2, gamma: 1, random: () => 0 });
  const never = new CompactionPressure({ start: 0, full: 0.2, gamma: 1, random: () => 0.999999 });
  const sample = { tokens: 120_000, contextWindow: 200_000 };
  const intermediate = always.sample(sample).probability;
  assert(intermediate > 0 && intermediate < 1, `intermediate probability ${intermediate}`);
  assertEq(always.sample(sample).fire, true);
  assertEq(never.sample(sample).fire, false);
});

test("pressure: either reason alone can saturate the ramp", () => {
  // Context degradation saturates by itself without rates.
  const degradationOnly = pressure().sample({ tokens: 200_000, contextWindow: 200_000 });
  assertEq(degradationOnly.economics, 0);
  assertEq(degradationOnly.probability, 1);
  // Economics saturates with a horizon long enough to amortize the rewrite.
  const economics = new CacheEconomics({ continuationProbability: 0.6 });
  const economicsOnly = new CompactionPressure({
    economics,
    degradation: new ContextDegradation({ start: 10, full: 11 }),
    random: () => 0,
  }).sample({ tokens: 120_000, contextWindow: 200_000, coldness: 1, rates });
  assert(economicsOnly.degradation === 0, "degradation disabled");
  assertEq(economicsOnly.probability, 1, "economics saturates alone");
});