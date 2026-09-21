/**
 * pi-cache — cache-warming observer tests.
 *
 * Only a real "warm" refresh resets the measured cache age; "stop" and an
 * absent action leave the last warm untouched. A landed refresh is confirmed
 * from the persisted `cache_warm` usage entries, newest-wins and deduped by
 * id, and combined with the decision intent by taking the most recent.
 */

import { test, assertEq } from "./harness.ts";
import { WarmingObserver } from "../src/warming-observer.ts";

const warm = (id: string, atMs: number) => ({
  type: "usage",
  id,
  kind: "cache_warm",
  timestamp: new Date(atMs).toISOString(),
});

test("warming-observer: only a warm decision resets the cache age", () => {
  let now = 1000;
  const observer = new WarmingObserver(() => now);
  assertEq(observer.msSinceLastWarm(), undefined, "no warm observed yet");
  observer.noteDecision("stop");
  assertEq(observer.msSinceLastWarm(), undefined, "stop is not a refresh");
  observer.noteDecision("warm");
  now = 4000;
  assertEq(observer.msSinceLastWarm(), 3000, "warm timed");
  observer.noteDecision(undefined);
  assertEq(observer.msSinceLastWarm(), 3000, "an absent action leaves the last warm");
});

test("warming-observer: reconcile confirms a landed refresh from its entry", () => {
  let now = 10_000;
  const observer = new WarmingObserver(() => now);
  observer.reconcile({ sessionManager: { getEntries: () => [warm("w1", 4000)] } });
  assertEq(observer.msSinceLastWarm(), 6000, "entry timestamp sets the age");
  now = 12_000;
  assertEq(observer.msSinceLastWarm(), 8000, "the confirmed time is stable");
});

test("warming-observer: the newest cache_warm wins and repeats are idempotent", () => {
  let now = 10_000;
  const entries = [warm("w1", 1000), warm("w2", 6000)];
  const observer = new WarmingObserver(() => now);
  observer.reconcile({ sessionManager: { getEntries: () => entries } });
  assertEq(observer.msSinceLastWarm(), 4000, "newest warm wins");
  now = 12_000;
  observer.reconcile({ sessionManager: { getEntries: () => entries } });
  assertEq(observer.msSinceLastWarm(), 6000, "an unchanged tail does not reset the age");
});

test("warming-observer: reconcile ignores other entries and empty sessions", () => {
  const observer = new WarmingObserver(() => 0);
  observer.reconcile(undefined);
  observer.reconcile({});
  observer.reconcile({ sessionManager: {} });
  observer.reconcile({
    sessionManager: {
      getEntries: () => [
        { type: "message", id: "m1" },
        { type: "usage", id: "u1", kind: "other", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "usage", id: "u2" },
      ],
    },
  });
  assertEq(observer.msSinceLastWarm(), undefined, "no warm entry observed");
});

test("warming-observer: the most recent of intent and confirmation measures the age", () => {
  let now = 1000;
  const observer = new WarmingObserver(() => now);
  observer.noteDecision("warm");
  now = 5000;
  observer.reconcile({ sessionManager: { getEntries: () => [warm("w1", 4000)] } });
  now = 9000;
  assertEq(observer.msSinceLastWarm(), 5000, "confirmation later than the intent");

  let now2 = 1000;
  const observer2 = new WarmingObserver(() => now2);
  observer2.reconcile({ sessionManager: { getEntries: () => [warm("w1", 1000)] } });
  now2 = 8000;
  observer2.noteDecision("warm");
  now2 = 10_000;
  assertEq(observer2.msSinceLastWarm(), 2000, "intent later than the confirmation");
});

test("warming-observer: a malformed timestamp falls back to the current clock", () => {
  let now = 7777;
  const observer = new WarmingObserver(() => now);
  observer.reconcile({
    sessionManager: { getEntries: () => [{ type: "usage", id: "w1", kind: "cache_warm" }] },
  });
  assertEq(observer.msSinceLastWarm(), 0, "fallback is the observation time");
  now = 8000;
  assertEq(observer.msSinceLastWarm(), 223, "and then ages from it");
});