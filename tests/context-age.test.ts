/**
 * pi-cache — context-age tests.
 * The measure sums entry gaps from the last compaction boundary's first kept
 * entry to the leaf, capping each gap at a short interval so idle or resumed
 * stretches cannot be charged as active time. The cap is its own argument,
 * never the provider cache TTL.
 */

import { test, assertEq } from "./harness.ts";

import { ContextAge, type AgeEntry } from "../src/context-age.ts";

const MINUTE = 60 * 1000;

/** An entry timestamped `offsetMinutes` after an arbitrary epoch. */
function entry(id: string, offsetMinutes: number, extra: Partial<AgeEntry> = {}): AgeEntry {
  const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + offsetMinutes * MINUTE).toISOString();
  return { id, type: "message", timestamp: at, ...extra };
}

function age(): ContextAge {
  return new ContextAge();
}

test("context-age: consecutive gaps are summed", () => {
  const branch = [entry("a", 0), entry("b", 3), entry("c", 5)];
  assertEq(age().activeMs(branch, 30 * MINUTE), 5 * MINUTE);
});

test("context-age: each gap is capped at the given cap", () => {
  // A one-hour hole in the middle counts as one capped interval, not an hour.
  const branch = [entry("a", 0), entry("b", 1), entry("c", 61)];
  assertEq(age().activeMs(branch, 5 * MINUTE), 1 * MINUTE + 5 * MINUTE);
});

test("context-age: a resume gap adds only the cap", () => {
  const branch = [entry("a", 0), entry("b", 1), entry("c", 600)];
  assertEq(age().activeMs(branch, 5 * MINUTE), 6 * MINUTE, "nine hours away is 5 minutes");
});

test("context-age: the gap from the leaf to now is never counted", () => {
  // The newest entry is an hour in the past; nothing may be charged for it.
  const branch = [entry("a", 0), entry("b", 1)];
  assertEq(age().activeMs(branch, 5 * MINUTE), 1 * MINUTE);
});

test("context-age: negative and future gaps add nothing", () => {
  // b is stamped before a, so a -> b is a negative gap and adds 0; the next
  // gap is measured from b, and its twelve minutes are capped at the cap.
  const branch = [entry("a", 0), entry("b", -10), entry("c", 2)];
  assertEq(age().activeMs(branch, 5 * MINUTE), 5 * MINUTE, "clock skew is not active time");
});

test("context-age: invalid timestamps are skipped, their gap merged and capped", () => {
  const branch = [
    entry("a", 0),
    { id: "b", type: "message" } as AgeEntry,
    { id: "c", type: "message", timestamp: "not-a-date" } as AgeEntry,
    entry("d", 7),
  ];
  assertEq(age().activeMs(branch, 5 * MINUTE), 5 * MINUTE);
});

test("context-age: fewer than two usable timestamps is zero", () => {
  assertEq(age().activeMs([], 5 * MINUTE), 0, "empty");
  assertEq(age().activeMs([entry("a", 0)], 5 * MINUTE), 0, "one");
  assertEq(age().activeMs([{ id: "a", type: "message" }], 5 * MINUTE), 0, "none parseable");
});

test("context-age: no branch reads as unknown, not as zero age", () => {
  assertEq(age().activeMs(undefined, 5 * MINUTE), undefined);
});

test("context-age: the measure starts at the last compaction's first kept entry", () => {
  const branch = [
    entry("a", 0),
    entry("b", 1),
    entry("c", 2),
    entry("d", 3, { type: "compaction", firstKeptEntryId: "c" }),
    entry("e", 4),
    entry("f", 6),
  ];
  // Only c -> d -> e -> f: 1 + 1 + 2 minutes. The dropped span is not live.
  assertEq(age().activeMs(branch, 30 * MINUTE), 4 * MINUTE);
});

test("context-age: only the newest compaction boundary counts", () => {
  const branch = [
    entry("a", 0),
    entry("b", 1, { type: "compaction", firstKeptEntryId: "a" }),
    entry("c", 2),
    entry("d", 3, { type: "compaction", firstKeptEntryId: "c" }),
    entry("e", 10),
  ];
  assertEq(age().activeMs(branch, 30 * MINUTE), 8 * MINUTE, "c -> d -> e");
});

test("context-age: a missing kept entry falls back to the compaction entry", () => {
  const branch = [
    entry("a", 0),
    entry("b", 1),
    entry("c", 2, { type: "compaction", firstKeptEntryId: "pi-cache-keep-none" }),
    entry("d", 5),
  ];
  assertEq(age().activeMs(branch, 30 * MINUTE), 3 * MINUTE, "c -> d only");
});

test("context-age: an unknown gap cap falls back to five minutes", () => {
  const branch = [entry("a", 0), entry("b", 100)];
  for (const cap of [0, -1, Number.NaN]) {
    assertEq(age().activeMs(branch, cap), 5 * MINUTE, `cap ${cap}`);
  }
});
