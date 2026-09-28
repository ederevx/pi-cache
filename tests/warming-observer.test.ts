/**
 * pi-cache — cache-warming observer tests.
 *
 * Only a confirmed "warm" refresh resets the measured cache age; "stop", an
 * absent action, and an unconfirmed intent leave it untouched. A landed
 * refresh is confirmed from the persisted `cache_warm` usage entries,
 * newest-wins and deduped by id; the decision intent is exposed separately
 * for the idle trigger's deferral guard.
 */

import { test, assertEq } from "./harness.ts";
import { WarmingObserver } from "../src/warming-observer.ts";

const warm = (id: string, atMs: number) => ({
  type: "usage",
  id,
  kind: "cache_warm",
  timestamp: new Date(atMs).toISOString(),
});

test("warming-observer: only a confirmed warm refresh resets the cache age", () => {
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
  assertEq(observer.msSinceLastWarm(), 3000, "a landed refresh sets the age");
  observer.noteDecision(undefined);
  assertEq(observer.msSinceLastWarm(), 3000, "an absent action leaves the confirmed warm");
});

test("warming-observer: reconcile confirms a landed refresh from its entry", () => {
  let now = 10_000;
  const observer = new WarmingObserver({ now: () => now });
  observer.reconcile({ sessionManager: { getEntries: () => [warm("w1", 4000)] } });
  assertEq(observer.msSinceLastWarm(), 6000, "entry timestamp sets the age");
  now = 12_000;
  assertEq(observer.msSinceLastWarm(), 8000, "the confirmed time is stable");
});

test("warming-observer: the newest cache_warm wins and repeats are idempotent", () => {
  let now = 10_000;
  const entries = [warm("w1", 1000), warm("w2", 6000)];
  const observer = new WarmingObserver({ now: () => now });
  observer.reconcile({ sessionManager: { getEntries: () => entries } });
  assertEq(observer.msSinceLastWarm(), 4000, "newest warm wins");
  now = 12_000;
  observer.reconcile({ sessionManager: { getEntries: () => entries } });
  assertEq(observer.msSinceLastWarm(), 6000, "an unchanged tail does not reset the age");
});

test("warming-observer: reconcile ignores other entries and empty sessions", () => {
  const observer = new WarmingObserver({ now: () => 0 });
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

test("warming-observer: an intent never overrides the confirmed touch age", () => {
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

test("warming-observer: a malformed timestamp falls back to the current clock", () => {
  let now = 7777;
  const observer = new WarmingObserver({ now: () => now });
  observer.reconcile({
    sessionManager: { getEntries: () => [{ type: "usage", id: "w1", kind: "cache_warm" }] },
  });
  assertEq(observer.msSinceLastWarm(), 0, "fallback is the observation time");
  now = 8000;
  assertEq(observer.msSinceLastWarm(), 223, "and then ages from it");
});
test("warming-observer: each newly confirmed entry fires onConfirm once", () => {
  const confirmed: string[] = [];
  let now = 10_000;
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

test("warming-observer: a throwing confirm sink never breaks the observer", () => {
  let now = 10_000;
  const observer = new WarmingObserver({
    now: () => now,
    onConfirm: () => {
      throw new Error("sink failure");
    },
  });
  observer.reconcile({ sessionManager: { getEntries: () => [warm("w1", 4000)] } });
  assertEq(observer.msSinceLastWarm(), 6000, "confirm state still updated");
});
