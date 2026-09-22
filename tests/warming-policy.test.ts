/**
 * pi-cache — forced-warming policy tests.
 * Enabled, the policy overrides pi's stop only when pi's own economics
 * still justify the warm (or are unavailable); disabled, it defers.
 */

import { test, assertEq } from "./harness.ts";
import { WarmingPolicy } from "../src/warming-policy.ts";

test("policy: disabled mode defers to pi's decision", () => {
  const policy = new WarmingPolicy(false);
  assertEq(policy.decide({ action: "stop" }), undefined);
  assertEq(policy.decide({ action: "warm" }), undefined);
  assertEq(policy.decide(undefined), undefined);
});

test("policy: enabled mode keeps a warm pi's economics justify", () => {
  const policy = new WarmingPolicy(true);
  // 0.9 * 1.00 - 0.80 = 0.10 >= $0.05 floor.
  assertEq(
    policy.decide({ action: "stop", warmCost: 0.8, missCost: 1.0, continuationProbability: 0.9 }),
    "warm",
  );
  // Exactly at the floor is still a warm.
  assertEq(
    policy.decide({ action: "stop", warmCost: 0.05, missCost: 1.0, continuationProbability: 0.1 }),
    "warm",
  );
});

test("policy: enabled mode defers when pi's economics say stop", () => {
  const policy = new WarmingPolicy(true);
  // 0.1 * 1.00 - 0.80 = -0.70 < $0.05 floor.
  assertEq(
    policy.decide({ action: "stop", warmCost: 0.8, missCost: 1.0, continuationProbability: 0.1 }),
    undefined,
  );
});

test("policy: enabled mode keeps a warm when pi's numbers are absent", () => {
  const policy = new WarmingPolicy(true);
  assertEq(policy.decide({ action: "stop" }), "warm", "no economics fields");
  // Zeroed sub-minimum costs DO compute: 0*0-0 = 0 < floor → defer.
  assertEq(
    policy.decide({ action: "stop", warmCost: 0, missCost: 0, continuationProbability: 0 }),
    undefined,
    "computed zero savings defers like pi's own decision",
  );
  assertEq(policy.decide(undefined), "warm", "no event at all");
});

test("policy: non-numeric economics fields count as unavailable", () => {
  const policy = new WarmingPolicy(true);
  assertEq(
    policy.decide({ action: "stop", warmCost: "0.1", missCost: 1, continuationProbability: 1 }),
    "warm",
  );
  assertEq(
    policy.decide({
      action: "stop",
      warmCost: Number.NaN,
      missCost: 1,
      continuationProbability: 1,
    }),
    "warm",
  );
});
