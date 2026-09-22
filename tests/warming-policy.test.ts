/**
 * pi-cache — forced-warming policy tests.
 * The policy overrides pi's warming economics only when enabled.
 */

import { test, assertEq } from "./harness.ts";
import { WarmingPolicy } from "../src/warming-policy.ts";

test("policy: forced mode answers warm regardless of pi's decision", () => {
  const policy = new WarmingPolicy(true);
  assertEq(policy.decide({ action: "stop" }), "warm");
  assertEq(policy.decide({ action: "warm" }), "warm");
  assertEq(policy.decide(undefined), "warm");
});

test("policy: default defers to pi's decision", () => {
  const policy = new WarmingPolicy(false);
  assertEq(policy.decide({ action: "stop" }), undefined);
  assertEq(policy.decide({ action: "warm" }), undefined);
});
