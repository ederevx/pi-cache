/**
 * pi-cache — cache-warming observer tests.
 * Only a real "warm" refresh resets the measured cache age; "stop" and an
 * absent action leave the last warm untouched.
 */

import { test, assertEq } from "./harness.ts";
import { WarmingObserver } from "../src/warming-observer.ts";

test("warming-observer: only a warm refresh resets the cache age", () => {
  let now = 1000;
  const observer = new WarmingObserver(() => now);
  assertEq(observer.msSinceLastWarm(), undefined, "no warm observed yet");
  observer.note("stop");
  assertEq(observer.msSinceLastWarm(), undefined, "stop is not a refresh");
  observer.note("warm");
  now = 4000;
  assertEq(observer.msSinceLastWarm(), 3000, "warm timed");
  observer.note(undefined);
  assertEq(observer.msSinceLastWarm(), 3000, "an absent action leaves the last warm");
});