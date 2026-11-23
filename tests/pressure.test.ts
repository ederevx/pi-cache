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

/** The fractional ramp alone, for tests that isolate the occupancy shape. */
function rampOnly(random: () => number = () => 0) {
  return new CompactionPressure({
    degradation: new ContextDegradation({ floor: 0 }),
    random,
  });
}

test("pressure: zero below the degradation onset and without rates", () => {
  const p = pressure();
  const verdict = p.sample({ tokens: 20_000, contextWindow: 200_000, coldness: 1 });
  assertEq(verdict.pressure, 0);
  assertEq(verdict.probability, 0);
  assertEq(verdict.fire, false);
});

test("pressure: degradation alone rises with occupancy", () => {
  const p = rampOnly();
  const at = (tokens: number) => p.sample({ tokens, contextWindow: 200_000 }).degradation;
  assertEq(at(100_000), 0, "at the onset start");
  assert(at(120_000) > 0, "past the onset start");
  assert(at(170_000) > at(120_000), "rising through the onset");
  assertEq(at(200_000), 1, "saturates at the onset full");
});

test("pressure: economics does not scale with token count", () => {
  const p = rampOnly();
  // Both occupancies stay below the 0.5 degradation onset, so only economics varies.
  const small = p.sample({ tokens: 20_000, contextWindow: 200_000, coldness: 1, rates });
  const large = p.sample({ tokens: 80_000, contextWindow: 200_000, coldness: 1, rates });
  assert(small.economics > 0, "a cold prefix pressures");
  assert(
    Math.abs(small.economics - large.economics) < 1e-9,
    "occupancy cancels out of the cost ratio (float tolerance)",
  );
  assertEq(small.degradation, 0, "still below the onset");
  assertEq(large.degradation, 0, "still below the onset");
});

test("pressure: a warm low-horizon prefix does not pressure", () => {
  const p = rampOnly();
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

test("pressure: a negative degradation gamma stays bounded", () => {
  // Regression: a negative exponent used to make pressure Infinity/NaN.
  const p = new CompactionPressure({
    economics: new CacheEconomics({ keepFraction: 0, continuationProbability: 0.6 }),
    degradation: new ContextDegradation({ start: 0.5, full: 0.85, gamma: -1 }),
    random: () => 0,
  });
  const verdict = p.sample({ tokens: 120_000, contextWindow: 200_000, coldness: 1, rates });
  assert(Number.isFinite(verdict.pressure), `pressure ${verdict.pressure}`);
  assert(verdict.pressure >= 0 && verdict.pressure <= 1, "pressure within [0,1]");
  assert(Number.isFinite(verdict.probability), `probability ${verdict.probability}`);
  assert(verdict.probability >= 0 && verdict.probability <= 1, "probability within [0,1]");
});

test("pressure: the injected RNG drives the draw", () => {
  const degradation = new ContextDegradation({ floor: 0 });
  const always = new CompactionPressure({ start: 0, full: 0.2, gamma: 1, degradation, random: () => 0 });
  const never = new CompactionPressure({
    start: 0,
    full: 0.2,
    gamma: 1,
    degradation,
    random: () => 0.999999,
  });
  const sample = { tokens: 120_000, contextWindow: 200_000 };
  const intermediate = always.sample(sample).probability;
  assert(intermediate > 0 && intermediate < 1, `intermediate probability ${intermediate}`);
  assertEq(always.sample(sample).fire, true);
  assertEq(never.sample(sample).fire, false);
});

test("pressure: probability() composes without consuming the draw", () => {
  let draws = 0;
  const p = new CompactionPressure({
    random: () => {
      draws++;
      return 0.5;
    },
  });
  const input = { tokens: 120_000, contextWindow: 200_000, coldness: 1 as const, rates };
  const probability = p.probability(input);
  assertEq(draws, 0, "no draw consumed by the predicate");
  assertEq(probability, p.sample(input).probability, "matches the sampled probability");
  assertEq(draws, 1, "an explicit sample draws exactly once");
});

test("pressure: preview matches the sampled values without drawing", () => {
  let draws = 0;
  const p = new CompactionPressure({
    random: () => {
      draws++;
      return 0.5;
    },
  });
  const input = { tokens: 120_000, contextWindow: 200_000, coldness: 1 as const, rates };
  const preview = p.preview(input);
  assertEq(draws, 0, "preview consumes no draw");
  const sampled = p.sample(input);
  assertEq(sampled.pressure, preview.pressure, "same pressure");
  assertEq(sampled.degradation, preview.degradation, "same degradation");
  assertEq(sampled.economics, preview.economics, "same economics");
  assertEq(sampled.probability, preview.probability, "same probability");
  assertEq(draws, 1, "only the explicit sample draws");
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
    degradation: new ContextDegradation({ start: 10, full: 11, floor: 0 }),
    random: () => 0,
  }).sample({ tokens: 120_000, contextWindow: 200_000, coldness: 1, rates });
  assert(economicsOnly.degradation === 0, "degradation disabled");
  assertEq(economicsOnly.probability, 1, "economics saturates alone");
});

test("pressure: degradationOnset follows the earlier of floor and ramp", () => {
  const p = pressure();
  assertEq(p.degradationOnset(200_000), 32_768, "a 200K window starts at the research floor");
  assertEq(p.degradationOnset(1_000_000), 125_000, "a 1M window starts at its share of the band");
  assertEq(
    new CompactionPressure({
      degradation: new ContextDegradation({ floor: 0 }),
      random: () => 0,
    }).degradationOnset(1_000_000),
    125_000,
    "a zero floor keeps the length onset: the age term still reads it",
  );
  assertEq(
    new CompactionPressure({
      degradation: new ContextDegradation({ floor: 0, halfLifeMs: 0 }),
      random: () => 0,
    }).degradationOnset(1_000_000),
    500_000,
    "with floor and age both off only the fractional ramp remains",
  );
});

test("pressure: zero rates leave degradation as the only reason", () => {
  const zero = { input: 0, cacheRead: 0, cacheWrite: 0 };
  const verdict = pressure().sample({
    tokens: 900_000,
    contextWindow: 1_000_000,
    coldness: 1,
    rates: zero,
  });
  assertEq(verdict.economics, 0, "no dollars to save");
  assertEq(verdict.probability, 1, "degradation saturates alone");
});
test("pressure: a 1M window is no longer saturated by the absolute band", () => {
  const p = pressure();
  assertEq(
    p.probability({ tokens: 190_000, contextWindow: 1_000_000 }),
    0,
    "190K is below the band's onset plus the deadband",
  );
  assert(
    p.probability({ tokens: 400_000, contextWindow: 1_000_000 }) < 0.3,
    "400K is a partial climb, not a saturated one",
  );
  assertEq(
    p.probability({ tokens: 350_000, contextWindow: 2_000_000 }),
    0,
    "a 2M window is later still",
  );
  assertEq(
    p.probability({ tokens: 700_000, contextWindow: 1_000_000 }),
    1,
    "and it still saturates before the window limit",
  );
});

test("pressure: active age cannot saturate a 1M window early", () => {
  const p = pressure();
  const hour = 60 * 60 * 1000;
  assertEq(
    p.probability({ tokens: 131_072, contextWindow: 1_000_000, contextActiveMs: hour }),
    0,
    "the old 131K saturation is gone",
  );
  assert(
    p.probability({ tokens: 200_000, contextWindow: 1_000_000, contextActiveMs: hour }) < 0.05,
    "200K after an hour stays in the deadband",
  );
  assert(
    p.probability({ tokens: 380_000, contextWindow: 1_000_000, contextActiveMs: hour }) < 1,
    "380K after an hour is high but not saturated",
  );
  assertEq(
    p.probability({ tokens: 450_000, contextWindow: 1_000_000, contextActiveMs: hour }),
    1,
    "450K after an hour saturates",
  );
  assert(
    p.probability({ tokens: 360_000, contextWindow: 1_000_000, contextActiveMs: 3 * hour }) < 1,
    "three hours is not quite saturated at 360K",
  );
  assertEq(
    p.probability({ tokens: 370_000, contextWindow: 1_000_000, contextActiveMs: 3 * hour }),
    1,
    "and saturates just after",
  );
  assertEq(
    p.probability({ tokens: 450_000, contextWindow: 1_000_000, contextActiveMs: hour }),
    1,
    "1M at 450K after an hour",
  );
  assert(
    p.probability({ tokens: 450_000, contextWindow: 2_000_000, contextActiveMs: hour }) < 1,
    "the same count and age on a 2M window is weaker",
  );
});
