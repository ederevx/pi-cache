/**
 * pi-cache — context-degradation tests.
 * The model maps occupancy and active context age to a [0,1] degradation
 * pressure with three parts: a research floor on absolute token count that
 * plateaus below 1 (a minimum, never a ceiling), the uncapped fractional
 * ramp toward the window limit (`start`/`full`/`gamma`), and an active-age
 * half-life that only applies to windows too large for occupancy to speak.
 */

import { test, assert, assertEq } from "./harness.ts";

import { ContextDegradation } from "../src/context-degradation.ts";

const HOUR = 60 * 60 * 1000;

function rampOnly(start = 0.5, full = 0.85, gamma = 1) {
  return new ContextDegradation({ start, full, gamma, floor: 0 });
}

test("degradation: zero at/below start and one at/above full", () => {
  const model = rampOnly(0.5, 0.85, 1);
  assertEq(model.pressure(0, 200_000), 0);
  assertEq(model.pressure(100_000, 200_000), 0, "exactly at start");
  assertEq(model.pressure(170_000, 200_000), 1, "exactly at full");
  assertEq(model.pressure(200_000, 200_000), 1, "clamped above full");
});

test("degradation: monotone and clamped in [0,1]", () => {
  const model = rampOnly(0.2, 0.6);
  const a = model.pressure(60_000, 200_000);
  const b = model.pressure(80_000, 200_000);
  const c = model.pressure(100_000, 200_000);
  assert(a < b && b < c, "rising through the onset");
  assert(
    [a, b, c].every((v) => v >= 0 && v <= 1),
    "bounded",
  );
});

test("degradation: gamma biases the ramp toward the top", () => {
  const linear = rampOnly(0, 1, 1);
  const curved = rampOnly(0, 1, 2);
  assert(
    curved.pressure(100_000, 200_000) < linear.pressure(100_000, 200_000),
    "squared ramp is lower",
  );
});

test("degradation: a negative gamma stays bounded", () => {
  // Regression: pow(0, negative) used to yield Infinity and break [0,1].
  const model = rampOnly(0.5, 0.85, -1);
  assertEq(model.pressure(20_000, 200_000), 0, "below the onset is exactly zero");
  const above = model.pressure(160_000, 200_000);
  assert(Number.isFinite(above) && above >= 0 && above <= 1, `bounded ${above}`);
});

test("degradation: the research floor rises from 32K and plateaus at 0.5", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1 });
  assertEq(model.pressure(32_768, 200_000), 0, "zero at the floor onset");
  const midpoint = (32_768 + 131_072) / 2;
  assertEq(model.pressure(midpoint, 1_000_000), 0.25, "linear between the anchors");
  assertEq(model.pressure(131_072, 1_000_000), 0.5, "plateau at the second anchor");
  assertEq(model.pressure(200_000, 1_000_000), 0.5, "and beyond it");
  assertEq(model.pressure(131_072, 10_000_000), 0.5, "a huge window changes nothing");
});

test("degradation: the floor is a minimum, never a ceiling", () => {
  // A 200K window: the ramp starts at 100K, so between 100K and 170K the
  // combined pressure must be at least both parts, and it reaches 1 at the
  // ramp's full point even though the floor alone plateaus at 0.5.
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 2 });
  for (const tokens of [40_000, 80_000, 100_000, 130_000, 170_000, 200_000]) {
    const pressure = model.pressure(tokens, 200_000);
    const floor = Math.min(0.5, (0.5 * (tokens - 32_768)) / (131_072 - 32_768));
    const rampSpan = 170_000 - 100_000;
    const ramp =
      tokens <= 100_000 ? 0 : Math.min(1, Math.pow(Math.min(1, (tokens - 100_000) / rampSpan), 2));
    assert(pressure >= floor - 1e-12, `>= floor at ${tokens} (${pressure} vs ${floor})`);
    assert(pressure >= ramp - 1e-12, `>= ramp at ${tokens} (${pressure} vs ${ramp})`);
  }
  assertEq(model.pressure(170_000, 200_000), 1, "the ramp still saturates the window");
});

test("degradation: a large window keeps climbing to the window limit", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 2 });
  assertEq(model.pressure(150_000, 1_000_000), 0.5, "floor plateau, ramp still 0");
  const midRamp = model.pressure(600_000, 1_000_000);
  const nearFull = model.pressure(840_000, 1_000_000);
  assert(midRamp > 0.5 && nearFull > midRamp, "rising toward the window limit");
  assertEq(model.pressure(850_000, 1_000_000), 1, "saturates at the fractional full");
});

test("degradation: a small window keeps exactly the fractional curve", () => {
  // W = 32K: the ramp starts at 16K, before the floor's onset, and the floor
  // can never engage within the window, so nothing changed for such models.
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 2 });
  const ramp = rampOnly(0.5, 0.85, 2);
  for (const tokens of [0, 16_000, 24_000, 31_000]) {
    assertEq(model.pressure(tokens, 32_000), ramp.pressure(tokens, 32_000), `at ${tokens}`);
  }
  assertEq(model.onset(32_000), 16_000, "the ramp's onset is earlier");
});

test("degradation: the onset is the earlier of the floor and the ramp", () => {
  const model = new ContextDegradation();
  assertEq(model.onset(200_000), 32_768, "a 200K window starts at the floor");
  assertEq(model.onset(1_000_000), 32_768, "so does a 1M window");
  assertEq(model.onset(32_000), 16_000, "a small window starts at the ramp");
  assertEq(model.onset(Number.POSITIVE_INFINITY), 32_768, "an unknown window starts at the floor");
  // A zero floor alone keeps the length onset: the age term still reads the
  // length evidence it multiplies. Only switching the age term off as well
  // leaves the ramp on its own.
  assertEq(new ContextDegradation({ floor: 0 }).onset(1_000_000), 32_768, "floor off, age on");
  assertEq(
    new ContextDegradation({ floor: 0, halfLifeMs: 0 }).onset(1_000_000),
    500_000,
    "floor and age off",
  );
});

test("degradation: an unknown window has no ramp and does not saturate", () => {
  // Regression: the old `Math.max(1, window)` turned an unknown window into
  // 1 token, so any token count saturated the ramp.
  const model = new ContextDegradation();
  for (const window of [0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assertEq(model.pressure(10_000, window), 0, `nothing to claim at ${window}`);
    assertEq(model.pressure(1_000_000, window), 0.5, `only the floor at ${window}`);
  }
});

test("degradation: only an unlimited window reads active time", () => {
  const model = new ContextDegradation();
  assertEq(model.unlimited(1_000_000), true, "1M");
  assertEq(model.unlimited(0), true, "unknown");
  assertEq(model.unlimited(262_144), true, "s . W == the floor plateau");
  assertEq(model.unlimited(262_143), false, "one token less");
  assertEq(model.unlimited(200_000), false, "a frontier-class window");

  // A trusted window ignores the clock entirely.
  assertEq(model.pressure(150_000, 200_000, 100 * HOUR), model.pressure(150_000, 200_000, 0));
});

test("degradation: the time ramp is a half-life, not a cliff", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 2 });
  // At 131K the floor is saturated (0.5) and the ramp is still 0, so the
  // pressure is 1 - (1 - 0.5) * (1 - 0.5) = 0.75 after one half-life.
  assertEq(model.pressure(150_000, 1_000_000, HOUR), 0.75);
  const quarter = model.pressure(150_000, 1_000_000, HOUR / 2) - 0.5;
  assert(quarter > 0 && quarter < 0.25, `half an hour is a partial climb (${quarter})`);
  assert(model.pressure(150_000, 1_000_000, 10 * HOUR) > 0.9, "approaches but never passes 1");
  assert(model.pressure(150_000, 1_000_000, 10 * HOUR) < 1, "bounded below 1 by the floor");
});

test("degradation: no time pressure below the floor's onset", () => {
  const model = new ContextDegradation();
  assertEq(model.pressure(20_000, 1_000_000, 100 * HOUR), 0, "length evidence is 0");
  assertEq(model.pressure(32_768, 1_000_000, 100 * HOUR), 0, "exactly at the onset");
});

test("degradation: a disabled half-life leaves time at zero", () => {
  for (const halfLifeMs of [0, -1]) {
    const model = new ContextDegradation({ halfLifeMs });
    assertEq(model.pressure(150_000, 1_000_000, HOUR), 0.5, `half-life ${halfLifeMs}`);
  }
  // A non-finite half-life is not a way to disable it: it falls back to the
  // default instead of silently turning the time component off.
  assertEq(new ContextDegradation({ halfLifeMs: Number.NaN }).pressure(150_000, 1_000_000, HOUR), 0.75);
});

test("degradation: junk ages and token counts stay bounded", () => {
  const model = new ContextDegradation();
  for (const activeMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    const value = model.pressure(150_000, 1_000_000, activeMs);
    assert(Number.isFinite(value) && value >= 0 && value <= 1, `age ${activeMs} -> ${value}`);
  }
  for (const tokens of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const value = model.pressure(tokens, 1_000_000, HOUR);
    assert(Number.isFinite(value) && value >= 0 && value <= 1, `tokens ${tokens} -> ${value}`);
  }
});

test("degradation: monotone in tokens at a fixed age, and in age at fixed tokens", () => {
  const model = new ContextDegradation();
  const tokens = [0, 20_000, 32_768, 60_000, 100_000, 131_072, 262_144, 400_000, 900_000];
  const ages = [0, HOUR / 2, HOUR, 4 * HOUR];
  for (const activeMs of ages) {
    let previous = -1;
    for (const count of tokens) {
      const value = model.pressure(count, 1_048_576, activeMs);
      assert(value >= previous - 1e-12, `monotone in tokens at ${count}/${activeMs}`);
      previous = value;
    }
  }
  for (const count of tokens) {
    let previous = -1;
    for (const activeMs of ages) {
      const value = model.pressure(count, 1_048_576, activeMs);
      assert(value >= previous - 1e-12, `monotone in age at ${count}/${activeMs}`);
      previous = value;
    }
  }
});

test("degradation: a zero floor does not silence the age term", () => {
  // Regression: length evidence used to be gated on the floor being > 0, so
  // PI_CACHE_PRESSURE_DEGRADE_FLOOR=0 silently disabled the half-life too.
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 2, floor: 0 });
  assertEq(model.pressure(150_000, 1_000_000, 0), 0, "no length, no occupancy ramp yet");
  assertEq(model.pressure(150_000, 1_000_000, HOUR), 0.5, "one half-life still climbs");
  assertEq(model.onset(1_000_000), 32_768, "the length onset still governs both");
});

test("degradation: a non-finite setting degrades to the default, never NaN", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const key of ["start", "full", "gamma", "floor", "floorStartTokens", "floorFullTokens", "halfLifeMs"] as const) {
      const model = new ContextDegradation({ [key]: bad } as never);
      const value = model.pressure(150_000, 1_000_000, HOUR);
      assert(Number.isFinite(value) && value >= 0 && value <= 1, `${key}=${bad} -> ${value}`);
      assert(Number.isFinite(model.onset(1_000_000)), `${key}=${bad} onset`);
      if (key === "floorStartTokens") {
        assertEq(model.onset(1_000_000), 32_768, `${key}=${bad} keeps the default onset`);
      }
    }
  }
});

test("degradation: the occupancy fractions are clamped to [0,1]", () => {
  // A negative start used to make the pressure nonzero at zero tokens and
  // onset() negative; start > 1 turned the unlimited test on far too early.
  const negative = new ContextDegradation({ start: -0.5, full: 0.85 });
  assertEq(negative.pressure(0, 200_000), 0, "nothing to claim at zero tokens");
  assertEq(negative.onset(200_000), 0, "the ramp starts at zero occupancy");
  const above = new ContextDegradation({ start: 4, full: 9, floor: 0, halfLifeMs: 0 });
  assertEq(above.pressure(150_000, 200_000, 0), 0, "the ramp starts at the window limit");
  assertEq(above.onset(200_000), 200_000, "and so does the onset");
  const floorStillGoverns = new ContextDegradation({ start: 4, full: 9 });
  assertEq(floorStillGoverns.onset(200_000), 32_768, "the floor onset still comes first");
  assertEq(floorStillGoverns.unlimited(200_000), true, "clamped to start=1, so 200K is unlimited");
  assertEq(
    new ContextDegradation({ start: 4, full: 0.1, floor: 0, halfLifeMs: 0 }).pressure(
      150_000,
      200_000,
    ),
    0,
    "a reversed pair collapses to the clamped start",
  );
});

test("degradation: equal or reversed thresholds stay finite and monotone", () => {
  // Equal points collapse to a single step: still zero at the onset itself,
  // saturated immediately above it.
  const equal = rampOnly(0.5, 0.5, 2);
  assertEq(equal.pressure(100_000, 200_000), 0, "at the single step");
  assertEq(equal.pressure(100_001, 200_000), 1, "one step above it");

  const reversed = rampOnly(0.8, 0.2, 2);
  const below = reversed.pressure(150_000, 200_000);
  const above = reversed.pressure(190_000, 200_000);
  assert(Number.isFinite(below) && Number.isFinite(above), "finite");
  assert(below <= above, "still monotone");
  assert(below >= 0 && above <= 1, "bounded");
});
