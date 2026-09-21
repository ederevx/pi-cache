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