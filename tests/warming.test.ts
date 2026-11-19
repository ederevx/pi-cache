/**
 * pi-cache — cache-warming tests.
 * The forced-warming policy overrides pi's stop only when pi's own
 * economics still justify the warm (or are unavailable) and defers
 * otherwise; the observer resets the measured cache age only for a
 * confirmed refresh, never for an intent; the schedule mirrors pi's
 * retention margin and follows the effective tier.
 */

import { test, assertEq } from "./harness.ts";
import { WarmingPolicy, type WarmingDecisionView } from "../src/warming-policy.ts";
import { WarmingObserver, type WarmUsageEntry } from "../src/warming-observer.ts";
import { SessionSignals } from "../src/signals.ts";
import { WarmingSchedule } from "../src/warming-schedule.ts";

const warm = (id: string, atMs: number): WarmUsageEntry => ({
  type: "usage",
  id,
  kind: "cache_warm",
  timestamp: new Date(atMs).toISOString(),
});

function schedule(effectiveLong: boolean | undefined): WarmingSchedule {
  // Production shares one retention owner: the signals' pi-native TTL view
  // follows the same effective tier the schedule reads for overrideActive.
  const tier = { effectiveLong: () => effectiveLong };
  const signals = new SessionSignals(
    {
      cacheRetentionLong: effectiveLong === true,
      fallbackTtlSeconds: 300,
      retentionLongOf: () => tier.effectiveLong(),
    },
    { lastUsage: () => undefined, msSinceLastTurn: () => 0, headChurn: () => 0 },
  );
  return new WarmingSchedule(signals, tier);
}

test("warming: policy defers entirely when disabled", () => {
  const policy = new WarmingPolicy(false);
  assertEq(policy.decide({ action: "stop" }), undefined);
  assertEq(policy.decide({ action: "warm" }), undefined);
  assertEq(policy.decide(undefined), undefined);
});

test("warming: policy honours pi's own savings floor", () => {
  const policy = new WarmingPolicy(true);
  // pi's model: continuationProbability * missCost - warmCost, $0.05 floor.
  const rows: Array<[string, WarmingDecisionView, string | undefined]> = [
    ["savings above the floor keep the warm", { action: "stop", warmCost: 0.8, missCost: 1.0, continuationProbability: 0.9 }, "warm"],
    ["exactly at the floor keeps the warm", { action: "stop", warmCost: 0.05, missCost: 1.0, continuationProbability: 0.1 }, "warm"],
    ["negative savings defer", { action: "stop", warmCost: 0.8, missCost: 1.0, continuationProbability: 0.1 }, undefined],
    ["computed zero savings defer", { action: "stop", warmCost: 0, missCost: 0, continuationProbability: 0 }, undefined],
  ];
  for (const [label, event, expected] of rows) {
    assertEq(policy.decide(event), expected, label);
  }
});

test("warming: policy keeps the warm when pi's numbers are unavailable", () => {
  const policy = new WarmingPolicy(true);
  const rows: Array<[string, WarmingDecisionView | undefined]> = [
    ["no economics fields", { action: "stop" }],
    ["no event at all", undefined],
    ["a string cost is not a number", { action: "stop", warmCost: "0.1", missCost: 1, continuationProbability: 1 }],
    ["a NaN cost is not a number", { action: "stop", warmCost: Number.NaN, missCost: 1, continuationProbability: 1 }],
  ];
  for (const [label, event] of rows) {
    assertEq(policy.decide(event), "warm", label);
  }
});

test("warming: policy defers on an empty prefix even without economics", () => {
  let hasTurns = false;
  const policy = new WarmingPolicy(true, { hasPromptEvidence: () => hasTurns });
  assertEq(policy.decide({}), undefined, "no prompt evidence: defer");
  hasTurns = true;
  assertEq(policy.decide({}), "warm", "a recorded turn keeps the cheap warm");
});

test("warming: policy without the evidence seam keeps the unavailable-economics warm", () => {
  const policy = new WarmingPolicy(true);
  assertEq(policy.decide({}), "warm", "unwired evidence keeps prior behavior");
});

test("warming: observer counts only a confirmed refresh", () => {
  let now = 1000;
  const observer = new WarmingObserver({ now: () => now });
  assertEq(observer.msSinceLastWarm(), undefined, "no warm observed yet");
  observer.noteDecision("stop");
  assertEq(observer.msSinceLastWarm(), undefined, "stop is not a refresh");
  observer.noteDecision("warm");
  assertEq(observer.msSinceLastWarm(), undefined, "an unconfirmed intent is not a touch");
  now = 4000;
  assertEq(observer.msSinceDecision(), 3000, "the intent is exposed for the idle guard");
  observer.reconcile({ sessionManager: { getEntries: () => [warm("w1", 1000)] } });
  assertEq(observer.msSinceLastWarm(), 3000, "a landed refresh sets the age from its entry");
  observer.noteDecision(undefined);
  assertEq(observer.msSinceLastWarm(), 3000, "an absent action leaves the confirmed warm");
  now = 12_000;
  assertEq(observer.msSinceLastWarm(), 11_000, "the confirmed time is stable");
});

test("warming: observer reads the newest cache_warm and ignores the rest", () => {
  let now = 10_000;
  const entries = [warm("w1", 1000), warm("w2", 6000)];
  const observer = new WarmingObserver({ now: () => now });
  observer.reconcile({ sessionManager: { getEntries: () => entries } });
  assertEq(observer.msSinceLastWarm(), 4000, "newest warm wins");
  now = 12_000;
  observer.reconcile({ sessionManager: { getEntries: () => entries } });
  assertEq(observer.msSinceLastWarm(), 6000, "an unchanged tail does not reset the age");

  const empty = new WarmingObserver({ now: () => 0 });
  empty.reconcile(undefined);
  empty.reconcile({});
  empty.reconcile({ sessionManager: {} });
  empty.reconcile({
    sessionManager: {
      getEntries: () => [
        { type: "message", id: "m1" },
        { type: "usage", id: "u1", kind: "other", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "usage", id: "u2" },
      ],
    },
  });
  assertEq(empty.msSinceLastWarm(), undefined, "no warm entry observed");
});

test("warming: observer never lets an intent override the confirmed touch age", () => {
  let now = 1000;
  const observer = new WarmingObserver({ now: () => now });
  observer.noteDecision("warm");
  now = 5000;
  observer.reconcile({ sessionManager: { getEntries: () => [warm("w1", 4000)] } });
  now = 9000;
  assertEq(observer.msSinceLastWarm(), 5000, "the confirmation sets the age");

  let now2 = 1000;
  const observer2 = new WarmingObserver({ now: () => now2 });
  observer2.reconcile({ sessionManager: { getEntries: () => [warm("w1", 1000)] } });
  now2 = 8000;
  observer2.noteDecision("warm");
  now2 = 10_000;
  assertEq(observer2.msSinceLastWarm(), 9000, "a later intent does not reset the age");
  assertEq(observer2.msSinceDecision(), 2000, "the intent is still observable");
});

test("warming: observer falls back to the observation clock on a malformed timestamp", () => {
  let now = 7777;
  const observer = new WarmingObserver({ now: () => now });
  observer.reconcile({
    sessionManager: { getEntries: () => [{ type: "usage", id: "w1", kind: "cache_warm" }] },
  });
  assertEq(observer.msSinceLastWarm(), 0, "fallback is the observation time");
  now = 8000;
  assertEq(observer.msSinceLastWarm(), 223, "and then ages from it");
});

test("warming: observer fires onConfirm once per newly confirmed entry", () => {
  const confirmed: string[] = [];
  const now = 10_000;
  const observer = new WarmingObserver({
    now: () => now,
    onConfirm: (entry) => confirmed.push(entry.id ?? "?"),
  });
  const entries = [warm("w1", 4000)];
  observer.reconcile({ sessionManager: { getEntries: () => entries } });
  assertEq(confirmed.join(","), "w1", "first landing confirmed");
  observer.reconcile({ sessionManager: { getEntries: () => entries } });
  assertEq(confirmed.length, 1, "re-reconcile is idempotent");
  entries.push(warm("w2", 9000));
  observer.reconcile({ sessionManager: { getEntries: () => entries } });
  assertEq(confirmed.join(","), "w1,w2", "newest landing confirmed once");
});

test("warming: observer survives a throwing confirm sink", () => {
  const now = 10_000;
  const observer = new WarmingObserver({
    now: () => now,
    onConfirm: () => {
      throw new Error("sink failure");
    },
  });
  observer.reconcile({ sessionManager: { getEntries: () => [warm("w1", 4000)] } });
  assertEq(observer.msSinceLastWarm(), 6000, "confirm state still updated");
});

test("warming: schedule margin mirrors pi's formula for the effective tier", () => {
  const ctx = { model: { promptCache: { short: 300, long: 3600 } } };
  const rows: Array<[string, boolean | undefined, number, boolean]> = [
    ["short tier", undefined, 300_000 * 0.9 - 10_000, false],
    ["override-lengthened tier", true, 3_600_000 * 0.9 - 10_000, true],
  ];
  for (const [label, effectiveLong, expected, overrideActive] of rows) {
    const warmSchedule = schedule(effectiveLong);
    assertEq(warmSchedule.refreshMarginMs(ctx), expected, label);
    assertEq(warmSchedule.overrideActive, overrideActive, `${label} override flag`);
  }
});

test("warming: schedule with an unknown tier schedules nothing", () => {
  const warmSchedule = schedule(undefined);
  assertEq(warmSchedule.refreshMarginMs(undefined), undefined, "no context");
  assertEq(warmSchedule.refreshMarginMs({ model: {} }), undefined, "no prompt-cache metadata");
});
