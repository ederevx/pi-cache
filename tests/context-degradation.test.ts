/**
 * pi-cache — context-degradation tests.
 * The model maps occupancy to a [0,1] degradation pressure that is 0
 * at/below `start`, 1 at/above `full`, and monotone in between, with
 * `gamma` shaping the ramp.
 */

import { test, assert, assertEq, assertDeepEq } from "./harness.ts";
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

test("degradation: the onset is capped at an absolute token budget", () => {
  const model = new ContextDegradation();
  assertDeepEq(model.onset(1_000_000), { start: 100_000, full: 200_000 }, "1M window capped");
  assertEq(model.pressure(100_000, 1_000_000), 0, "at the capped start");
  assert(
    Math.abs(model.pressure(150_000, 1_000_000) - 0.25) < 1e-9,
    "a quarter of the ramp at the midpoint",
  );
  assertEq(model.pressure(200_000, 1_000_000), 1, "saturates at the capped full");
});

test("degradation: windows at/below the caps keep the pure fraction onset", () => {
  const model = new ContextDegradation();
  assertDeepEq(model.onset(200_000), { start: 100_000, full: 170_000 });
  assertDeepEq(model.onset(128_000), { start: 64_000, full: 108_800 });
});

test("degradation: a non-positive cap restores the uncapped fraction onset", () => {
  const model = new ContextDegradation({ startTokens: 0, fullTokens: 0 });
  assertDeepEq(model.onset(1_000_000), { start: 500_000, full: 850_000 });
  assertEq(model.pressure(500_000, 1_000_000), 0, "uncapped start");
  assertEq(model.pressure(850_000, 1_000_000), 1, "uncapped full");
});

test("degradation: an inverted cap collapses the onset but stays bounded", () => {
  const model = new ContextDegradation({ startTokens: 300_000, fullTokens: 200_000 });
  assertDeepEq(model.onset(1_000_000), { start: 300_000, full: 300_000 });
  assertEq(model.pressure(300_000, 1_000_000), 0, "at the collapsed onset");
  assertEq(model.pressure(400_000, 1_000_000), 1, "above the collapsed onset");
  assert(Number.isFinite(model.pressure(500_000, 1_000_000)), "stays finite");
});