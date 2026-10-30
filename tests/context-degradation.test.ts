/**
 * pi-cache — context-degradation tests.
 * The model maps occupancy to a [0,1] degradation pressure that is 0
 * at/below `start`, 1 at/above `full`, and monotone in between, with
 * `gamma` shaping the ramp.
 */

import { test, assert, assertEq } from "./harness.ts";
import { ContextDegradation } from "../src/context-degradation.ts";

test("degradation: zero at/below start and one at/above full", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1 });
  assertEq(model.pressure(0, 200_000), 0);
  assertEq(model.pressure(100_000, 200_000), 0, "exactly at start");
  assertEq(model.pressure(170_000, 200_000), 1, "exactly at full");
  assertEq(model.pressure(200_000, 200_000), 1, "clamped above full");
});

test("degradation: monotone and clamped in [0,1]", () => {
  const model = new ContextDegradation({ start: 0.2, full: 0.6, gamma: 1 });
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
  const linear = new ContextDegradation({ start: 0, full: 1, gamma: 1 });
  const curved = new ContextDegradation({ start: 0, full: 1, gamma: 2 });
  assert(
    curved.pressure(100_000, 200_000) < linear.pressure(100_000, 200_000),
    "squared ramp is lower",
  );
});

test("degradation: a negative gamma stays bounded", () => {
  // Regression: pow(0, negative) used to yield Infinity and break [0,1].
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: -1 });
  assertEq(model.pressure(20_000, 200_000), 0, "below the onset is exactly zero");
  const above = model.pressure(160_000, 200_000);
  assert(Number.isFinite(above) && above >= 0 && above <= 1, `bounded ${above}`);
});

test("degradation: token caps bound a large window", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1 });
  assertEq(model.onset(1_000_000), 100_000, "a 1M window starts at the cap");
  assertEq(model.pressure(100_000, 1_000_000), 0, "zero at the capped onset");
  assertEq(model.pressure(200_000, 1_000_000), 1, "saturated at the full cap");
  assertEq(model.onset(200_000), 100_000, "a 200K window keeps its fraction");
});

test("degradation: each cap can be disabled independently", () => {
  const startCapped = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1, startTokens: 0 });
  assertEq(startCapped.onset(1_000_000), 500_000, "fraction restored for start");
  assertEq(startCapped.pressure(499_999, 1_000_000), 0, "zero below the fractional onset");

  const fullCapped = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1, fullTokens: 0 });
  assertEq(fullCapped.onset(1_000_000), 100_000, "start stays capped");
  assertEq(fullCapped.pressure(850_000, 1_000_000), 1, "fraction restored for full");

  const uncapped = new ContextDegradation({
    start: 0.5,
    full: 0.85,
    gamma: 1,
    startTokens: 0,
    fullTokens: 0,
  });
  assertEq(uncapped.pressure(499_999, 1_000_000), 0, "fractional onset");
  assertEq(uncapped.pressure(850_000, 1_000_000), 1, "fractional saturation");
});

test("degradation: a capped window ramps between the absolute points", () => {
  const model = new ContextDegradation({ start: 0.5, full: 0.85, gamma: 2 });
  assertEq(model.pressure(150_000, 1_000_000), 0.25, "halfway between the caps");
  assertEq(model.pressure(150_000, 200_000), 0.5102040816326531, "fractional full point kept");
});

test("degradation: crossed token budgets collapse to a step at the start", () => {
  const model = new ContextDegradation({
    start: 0.5,
    full: 0.85,
    gamma: 2,
    startTokens: 300_000,
    fullTokens: 150_000,
  });
  assertEq(model.onset(1_000_000), 300_000, "the start budget bounds the onset");
  assertEq(model.pressure(300_000, 1_000_000), 0, "zero at the collapsed step");
  assertEq(model.pressure(300_001, 1_000_000), 1, "saturated one step above it");
});

test("degradation: equal or reversed thresholds stay finite and monotone", () => {
  // Equal points collapse to a single step: still zero at the onset itself,
  // saturated immediately above it.
  const equal = new ContextDegradation({ start: 0.5, full: 0.5, gamma: 2 });
  assertEq(equal.pressure(100_000, 200_000), 0, "at the single step");
  assertEq(equal.pressure(100_001, 200_000), 1, "one step above it");

  const reversed = new ContextDegradation({ start: 0.8, full: 0.2, gamma: 2 });
  const below = reversed.pressure(150_000, 200_000);
  const above = reversed.pressure(190_000, 200_000);
  assert(Number.isFinite(below) && Number.isFinite(above), "finite");
  assert(below <= above, "still monotone");
  assert(below >= 0 && above <= 1, "bounded");
});