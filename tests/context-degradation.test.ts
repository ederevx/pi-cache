/**
 * pi-cache — context-degradation tests.
 * The model maps occupancy and active context age to a [0,1] degradation
 * pressure: a research band on token count that starts at the larger of
 * 32 768 tokens and an eighth of the window and plateaus at the larger of
 * 131 072 and half of it (a minimum, never a ceiling), the uncapped
 * fractional ramp toward the window limit (`start`/`full`/`gamma`), and an
 * active-age half-life that raises that band's plateau and only applies to
 * windows too large for occupancy to speak.
 */

import { test, assert, assertEq } from "./harness.ts";

import { ContextDegradation } from "../src/context-degradation.ts";

const HOUR = 60 * 60 * 1000;

function rampOnly(start = 0.5, full = 0.85, gamma = 1) {
  return new ContextDegradation({ start, full, gamma, floor: 0 });
}

test("degradation: pressure stays finite, bounded and monotone on junk input", () => {
  const exact: Array<[string, ContextDegradation, number, number, number | undefined, number]> = [
    ["zero at zero tokens", rampOnly(0.5, 0.85, 1), 0, 200_000, undefined, 0],
    ["zero exactly at the onset", rampOnly(0.5, 0.85, 1), 100_000, 200_000, undefined, 0],
    ["one exactly at the full point", rampOnly(0.5, 0.85, 1), 170_000, 200_000, undefined, 1],
    ["clamped above the full point", rampOnly(0.5, 0.85, 1), 200_000, 200_000, undefined, 1],
    ["equal thresholds collapse to a step", rampOnly(0.5, 0.5, 2), 100_000, 200_000, undefined, 0],
    ["one token above that step", rampOnly(0.5, 0.5, 2), 100_001, 200_000, undefined, 1],
  ];
  for (const [label, model, tokens, window, activeMs, expected] of exact) {
    assertEq(model.pressure(tokens, window, activeMs), expected, label);
  }

  const rising = [60_000, 80_000, 100_000].map((tokens) => rampOnly(0.2, 0.6).pressure(tokens, 200_000));
  assert(rising[0] < rising[1] && rising[1] < rising[2], "rising through the onset");
  assert(rising.every((value) => value >= 0 && value <= 1), "bounded");

  const model = new ContextDegradation();
  for (const activeMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    const value = model.pressure(150_000, 1_000_000, activeMs);
    assert(Number.isFinite(value) && value >= 0 && value <= 1, `age ${activeMs} -> ${value}`);
  }
  for (const tokens of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const value = model.pressure(tokens, 1_000_000, HOUR);
    assert(Number.isFinite(value) && value >= 0 && value <= 1, `tokens ${tokens} -> ${value}`);
  }
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const key of [
      "start",
      "full",
      "gamma",
      "floor",
      "floorStartTokens",
      "floorFullTokens",
      "floorStartFraction",
      "floorFullFraction",
      "halfLifeMs",
    ] as const) {
      const configured = new ContextDegradation({ [key]: bad } as never);
      const value = configured.pressure(150_000, 1_000_000, HOUR);
      assert(Number.isFinite(value) && value >= 0 && value <= 1, `${key}=${bad} -> ${value}`);
      assert(Number.isFinite(configured.onset(1_000_000)), `${key}=${bad} onset`);
      if (key === "floorStartTokens") {
        assertEq(configured.onset(1_000_000), 125_000, `${key}=${bad} keeps the default onset`);
      }
    }
  }

  const reversed = rampOnly(0.8, 0.2, 2);
  const below = reversed.pressure(150_000, 200_000);
  const above = reversed.pressure(190_000, 200_000);
  assert(Number.isFinite(below) && Number.isFinite(above), "reversed thresholds stay finite");
  assert(below <= above, "still monotone");
  assert(below >= 0 && above <= 1, "bounded");
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

test("degradation: the research floor rises from the anchors and never ceilings the ramp", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1 });
  assertEq(model.pressure(32_768, 200_000), 0, "zero at the floor onset");
  const midpoint = (32_768 + 131_072) / 2;
  assertEq(
    model.pressure(midpoint, Number.POSITIVE_INFINITY),
    0.25,
    "linear between the anchors",
  );
  assertEq(
    model.pressure(131_072, Number.POSITIVE_INFINITY),
    0.5,
    "plateau at the second anchor",
  );
  assertEq(model.pressure(200_000, Number.POSITIVE_INFINITY), 0.5, "and beyond it");
  assertEq(model.pressure(131_072, 10_000_000), 0, "a huge window scales the band");

  // A 200K window: the ramp starts at 100K, so between 100K and 170K the
  // combined pressure must be at least both parts, and it reaches 1 at the
  // ramp's full point even though the floor alone plateaus at 0.5.
  const combined = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 2 });
  for (const tokens of [40_000, 80_000, 100_000, 130_000, 170_000, 200_000]) {
    const pressure = combined.pressure(tokens, 200_000);
    const floor = Math.min(0.5, (0.5 * (tokens - 32_768)) / (131_072 - 32_768));
    const rampSpan = 170_000 - 100_000;
    const ramp =
      tokens <= 100_000 ? 0 : Math.min(1, Math.pow(Math.min(1, (tokens - 100_000) / rampSpan), 2));
    assert(pressure >= floor - 1e-12, `>= floor at ${tokens} (${pressure} vs ${floor})`);
    assert(pressure >= ramp - 1e-12, `>= ramp at ${tokens} (${pressure} vs ${ramp})`);
  }
  assertEq(combined.pressure(170_000, 200_000), 1, "the ramp still saturates the window");
});

test("degradation: the ramp and the onset follow the window size", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 2 });
  // A large window: the floor plateaus while the ramp keeps climbing.
  assertEq(model.pressure(500_000, 1_000_000), 0.5, "floor plateau, ramp still 0");
  const midRamp = model.pressure(600_000, 1_000_000);
  const nearFull = model.pressure(840_000, 1_000_000);
  assert(midRamp > 0.5 && nearFull > midRamp, "rising toward the window limit");
  assertEq(model.pressure(850_000, 1_000_000), 1, "saturates at the fractional full");

  // W = 32K: the ramp starts at 16K, before the floor's onset, and the floor
  // can never engage within the window, so nothing changed for such models.
  const ramp = rampOnly(0.5, 0.85, 2);
  for (const tokens of [0, 16_000, 24_000, 31_000]) {
    assertEq(model.pressure(tokens, 32_000), ramp.pressure(tokens, 32_000), `at ${tokens}`);
  }
  assertEq(model.onset(32_000), 16_000, "the ramp's onset is earlier");

  const fresh = new ContextDegradation();
  assertEq(fresh.onset(200_000), 32_768, "a 200K window starts at the floor");
  assertEq(fresh.onset(1_000_000), 125_000, "a 1M window starts at its share of the band");
  assertEq(fresh.onset(32_000), 16_000, "a small window starts at the ramp");
  assertEq(fresh.onset(Number.POSITIVE_INFINITY), 32_768, "an unknown window starts at the floor");
  // A zero floor alone keeps the length onset: the age term still reads the
  // length evidence it raises. Only switching the age term off as well leaves
  // the ramp on its own.
  assertEq(new ContextDegradation({ floor: 0 }).onset(1_000_000), 125_000, "floor off, age on");
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
  // At 500K the band is saturated (0.5) and the ramp is still 0, so one
  // half-life raises the plateau to 0.75.
  assertEq(model.pressure(500_000, 1_000_000, HOUR), 0.75);
  const quarter = model.pressure(500_000, 1_000_000, HOUR / 2) - 0.5;
  assert(quarter > 0 && quarter < 0.25, `half an hour is a partial climb (${quarter})`);
  assert(model.pressure(500_000, 1_000_000, 10 * HOUR) > 0.9, "approaches but never passes 1");
  assert(model.pressure(500_000, 1_000_000, 10 * HOUR) < 1, "bounded below 1 by the plateau");

  // Below the band's onset there is no length evidence, so no time pressure.
  const fresh = new ContextDegradation();
  assertEq(fresh.pressure(20_000, 1_000_000, 100 * HOUR), 0, "length evidence is 0");
  assertEq(fresh.pressure(125_000, 1_000_000, 100 * HOUR), 0, "exactly at the onset");
});

test("degradation: a disabled half-life leaves time at zero", () => {
  for (const halfLifeMs of [0, -1]) {
    const model = new ContextDegradation({ halfLifeMs });
    assertEq(model.pressure(500_000, 1_000_000, HOUR), 0.5, `half-life ${halfLifeMs}`);
  }
  // A non-finite half-life is not a way to disable it: it falls back to the
  // default instead of silently turning the time component off.
  assertEq(new ContextDegradation({ halfLifeMs: Number.NaN }).pressure(500_000, 1_000_000, HOUR), 0.75);
});

test("degradation: monotone in tokens at a fixed age, and in age at fixed tokens", () => {
  const model = new ContextDegradation();
  const tokens = [0, 32_768, 125_000, 131_072, 250_000, 400_000, 500_000, 900_000, 1_300_000, 1_800_000];
  const ages = [0, HOUR / 2, HOUR, 3 * HOUR, 100 * HOUR];
  for (const window of [1_000_000, 1_048_576, 2_000_000, Number.POSITIVE_INFINITY]) {
    for (const activeMs of ages) {
      let previous = -1;
      for (const count of tokens) {
        const value = model.pressure(count, window, activeMs);
        assert(value >= previous - 1e-12, `monotone in tokens at ${count}/${window}/${activeMs}`);
        previous = value;
      }
    }
    for (const count of tokens) {
      let previous = -1;
      for (const activeMs of ages) {
        const value = model.pressure(count, window, activeMs);
        assert(value >= previous - 1e-12, `monotone in age at ${count}/${window}/${activeMs}`);
        previous = value;
      }
    }
  }
});

test("degradation: a zero floor does not silence the age term", () => {
  // Regression: length evidence used to be gated on the floor being > 0, so
  // PI_CACHE_PRESSURE_DEGRADE_FLOOR=0 silently disabled the half-life too.
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 2, floor: 0 });
  assertEq(model.pressure(500_000, 1_000_000, 0), 0, "no length, no occupancy ramp yet");
  assertEq(model.pressure(500_000, 1_000_000, HOUR), 0.5, "one half-life still climbs");
  assertEq(model.onset(1_000_000), 125_000, "the length onset still governs both");
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

test("degradation: the length band scales with windows at and above 256Ki", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1 });
  assertEq(model.onset(1_048_576), 131_072, "a 1M window starts at an eighth");
  assertEq(model.onset(2_097_152), 262_144, "a 2M window starts at twice that");
  assertEq(model.pressure(131_072, 1_048_576), 0, "zero at the scaled onset");
  assertEq(model.pressure(327_680, 1_048_576), 0.25, "halfway up the scaled band");
  assertEq(model.pressure(524_288, 1_048_576), 0.5, "plateau at half the window");
  assertEq(model.pressure(655_360, 2_097_152), 0.25, "the 2M band is twice as long");
  assert(
    model.pressure(524_288, 2_097_152) < model.pressure(524_288, 1_048_576),
    "the same count is weaker on a wider window",
  );
  assertEq(model.onset(1_000_000), 125_000, "a decimal 1M window");
  assertEq(model.onset(2_000_000), 250_000, "a decimal 2M window");
});

test("degradation: windows below 256Ki keep the absolute band exactly", () => {
  const model = new ContextDegradation();
  const absolute = new ContextDegradation({ floorStartFraction: 0, floorFullFraction: 0 });
  const counts = [0, 16_000, 32_768, 81_920, 100_000, 131_072, 170_000, 262_143];
  for (const window of [32_000, 131_072, 200_000, 262_143]) {
    for (const count of counts) {
      for (const activeMs of [0, HOUR, 4 * HOUR]) {
        assertEq(
          model.pressure(count, window, activeMs),
          absolute.pressure(count, window, activeMs),
          `W=${window} x=${count} a=${activeMs}`,
        );
      }
    }
  }
  assertEq(model.pressure(81_920, 200_000), 0.25, "the 200K window keeps its curve");
  for (const window of [131_072, 200_000, 262_144]) {
    assertEq(model.onset(window), 32_768, `onset at ${window}`);
  }
});

test("degradation: fractions of 0 restore the 0.19 band", () => {
  const legacy = new ContextDegradation({ floorStartFraction: 0, floorFullFraction: 0 });
  assertEq(legacy.onset(1_000_000), 32_768, "the absolute onset again");
  assertEq(legacy.pressure(150_000, 1_000_000), 0.5, "and its plateau");
});

test("degradation: age raises the plateau instead of adding a correlated reason", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1 });
  assertEq(model.pressure(524_288, 1_048_576, HOUR), 0.75, "a saturated band, one half-life");
  assertEq(model.pressure(327_680, 1_048_576, HOUR), 0.375, "half the band, one half-life");
  assertEq(model.pressure(327_680, 1_048_576, 0), 0.25, "and without the age");
  const noFloor = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1, floor: 0 });
  assertEq(noFloor.pressure(524_288, 1_048_576, HOUR), 0.5, "a zero floor still reads the age");
  assertEq(noFloor.pressure(524_288, 1_048_576, 0), 0, "and claims nothing without it");
});

test("degradation: an unknown window keeps the absolute band", () => {
  const model = new ContextDegradation();
  for (const window of [0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assertEq(model.onset(window), 32_768, `onset at ${window}`);
    assertEq(model.pressure(81_920, window), 0.25, `halfway at ${window}`);
    assertEq(model.pressure(1_000_000, window), 0.5, `plateau at ${window}`);
  }
});

test("degradation: the onset is where the pressure first exceeds zero", () => {
  const model = new ContextDegradation();
  for (const window of [32_000, 200_000, 1_000_000, 2_000_000, Number.POSITIVE_INFINITY]) {
    const onset = model.onset(window);
    assertEq(model.pressure(onset, window, 4 * HOUR), 0, `zero at the onset of ${window}`);
    assert(model.pressure(onset + 1, window, 4 * HOUR) > 0, `above the onset of ${window}`);
  }
});

test("degradation: the band fractions fail closed on junk input", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const key of ["floorStartFraction", "floorFullFraction"] as const) {
      const configured = new ContextDegradation({ [key]: bad } as never);
      assertEq(configured.onset(1_000_000), 125_000, `${key}=${bad} keeps the default onset`);
      const value = configured.pressure(400_000, 1_000_000, HOUR);
      assert(Number.isFinite(value) && value >= 0 && value <= 1, `${key}=${bad} -> ${value}`);
    }
  }
  assertEq(
    new ContextDegradation({ floorStartFraction: -1 }).onset(1_000_000),
    32_768,
    "a negative fraction clamps to the absolute onset",
  );
  assertEq(
    new ContextDegradation({ floorStartFraction: 4 }).onset(1_000_000),
    500_000,
    "a fraction above 1 clamps to the ramp's own onset",
  );
  const reversed = new ContextDegradation({ floorStartFraction: 0.4, floorFullFraction: 0.1 });
  const value = reversed.pressure(700_000, 1_000_000, HOUR);
  assert(Number.isFinite(value) && value >= 0 && value <= 1, `a reversed pair stays bounded (${value})`);

  // The fractions scale a band that only exists while length evidence is on.
  const noLength = new ContextDegradation({ floorStartTokens: 0 });
  assertEq(noLength.pressure(400_000, 1_000_000, HOUR), 0, "no length evidence");
  assertEq(noLength.onset(1_000_000), 500_000, "only the fractional ramp remains");
});
