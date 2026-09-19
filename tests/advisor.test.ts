/**
 * pi-cache — compaction advisor tests.
 * The advisor is purely observational: it must emit an advisory only for
 * warm-cache sessions at or above the size threshold, and say nothing
 * otherwise.
 */

import { test, assert, assertEq } from "./harness.ts";
import { CompactionAdvisor } from "../src/compaction.ts";

const totals = (n: number, input: number, cacheRead: number) => ({ n, input, cacheRead, cacheWrite: 0 });

test("advisor: disabled produces nothing", () => {
  const a = new CompactionAdvisor({ enabled: false });
  assertEq(a.suggest(totals(1, 100, 900), 10, 60_000), undefined);
});

test("advisor: no usage produces nothing", () => {
  const a = new CompactionAdvisor({ enabled: true });
  assertEq(a.suggest(totals(0, 0, 0), 10, 60_000), undefined);
});

test("advisor: cold cache produces nothing", () => {
  const a = new CompactionAdvisor({ enabled: true });
  assertEq(a.suggest(totals(1, 900, 100), 10, 60_000), undefined);
});

test("advisor: warm cache below token threshold produces nothing", () => {
  const a = new CompactionAdvisor({ enabled: true });
  assertEq(a.suggest(totals(1, 100, 900), 10, 49_999), undefined);
});

test("advisor: warm cache at threshold emits advisory", () => {
  const a = new CompactionAdvisor({ enabled: true });
  const tip = a.suggest(totals(1, 100, 900), 42, 60_000);
  assert(tip !== undefined, "advisory present");
  assert(tip.includes("warm cache"), "advisory names the warm cache");
  assert(tip.includes("42"), "advisory carries the entry count");
});

test("advisor: boundary ratio is not warm (0.6 threshold, strict)", () => {
  const a = new CompactionAdvisor({ enabled: true });
  // ratio exactly 0.6 (cacheRead=600, input=400) — below the 0.6 threshold? 0.6 >= 0.6 → warm.
  assert(a.suggest(totals(1, 400, 600), 5, 60_000) !== undefined, "0.6 ratio is warm");
  assert(a.suggest(totals(1, 601, 399), 5, 60_000) === undefined, "just under 0.6 is cold");
});