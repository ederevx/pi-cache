/**
 * pi-cache — affinity observer tests.
 * The observer must track the provider session-affinity header across
 * requests and report rotation without ever throwing on odd input.
 */

import { test, assert, assertEq, assertMatches } from "./harness.ts";
import { AffinityObserver } from "../src/affinity.ts";

test("affinity: no requests yet", () => {
  const a = new AffinityObserver();
  assertEq(a.rotated(), false);
  assertEq(a.status(), "affinity n/a");
});

test("affinity: stable header across requests", () => {
  const a = new AffinityObserver();
  a.note({ "x-session-id": "abc" });
  a.note({ "x-session-id": "abc" });
  assertEq(a.rotated(), false);
  assertMatches(a.status(), /stable \(id set\)/);
});

test("affinity: rotation is detected", () => {
  const a = new AffinityObserver();
  a.note({ session_id: "one" });
  a.note({ session_id: "two" });
  assertEq(a.rotated(), true);
  assertMatches(a.status(), /changed 1x/);
});

test("affinity: absent header is reported", () => {
  const a = new AffinityObserver();
  a.note({ "content-type": "application/json" });
  assertEq(a.rotated(), false);
  assertMatches(a.status(), /no header/);
});

test("affinity: non-session header keys are ignored", () => {
  const a = new AffinityObserver();
  a.note({ "x-ratelimit-remaining": "5" });
  assertEq(a.rotated(), false);
});

test("affinity: odd header shapes never throw", () => {
  const a = new AffinityObserver();
  a.note({} as never);
  a.note(null as never);
  a.note(undefined as never);
  assertEq(a.status(), "affinity stable (no header)", "null/undefined headers count as seen, no id");
});