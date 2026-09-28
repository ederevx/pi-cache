/**
 * pi-cache — retention-aware warming schedule tests.
 * The margin mirrors pi's (90% of the effective tier's lifetime less
 * 10s, floored at 1s) and follows the per-request tier rewrite.
 */

import { test, assertEq } from "./harness.ts";
import { SessionSignals } from "../src/signals.ts";
import { WarmingSchedule } from "../src/warming-schedule.ts";

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

test("schedule: short tier uses pi's margin formula", () => {
  const ctx = { model: { promptCache: { short: 300, long: 3600 } } };
  assertEq(schedule(undefined).refreshMarginMs(ctx), 300_000 * 0.9 - 10_000);
});

test("schedule: an override-lengthened tier extends the margin", () => {
  const ctx = { model: { promptCache: { short: 300, long: 3600 } } };
  assertEq(schedule(true).refreshMarginMs(ctx), 3_600_000 * 0.9 - 10_000);
  assertEq(schedule(true).overrideActive, true);
  assertEq(schedule(undefined).overrideActive, false);
});

test("schedule: an unknown tier schedules nothing", () => {
  assertEq(schedule(undefined).refreshMarginMs(undefined), undefined);
  assertEq(schedule(undefined).refreshMarginMs({ model: {} }), undefined);
});
