/**
 * pi-cache — fast compaction override tests.
 * propose() must emit the byte-stable stub at pi's own cut point when
 * enabled, and must return undefined (leaving pi's summarizer intact) when
 * disabled or given a malformed preparation.
 */

import { test, assert, assertEq } from "./harness.ts";
import { FastCompactionController, FAST_BRANCH_STUB, FAST_SUMMARY_STUB } from "../src/fastcompact.ts";

const prep = { firstKeptEntryId: "E42", tokensBefore: 123_456 };

test("fastcompact: disabled proposes nothing", () => {
  const c = new FastCompactionController({ enabled: false });
  assertEq(c.propose(prep), undefined);
});

test("fastcompact: enabled proposes the byte-stable stub at pi's cut", () => {
  const c = new FastCompactionController({ enabled: true });
  const proposal = c.propose(prep);
  assert(proposal !== undefined, "proposal expected");
  assertEq(proposal!.summary, FAST_SUMMARY_STUB);
  assertEq(proposal!.firstKeptEntryId, "E42");
  assertEq(proposal!.tokensBefore, 123_456);
});

test("fastcompact: malformed preparation fails open", () => {
  const c = new FastCompactionController({ enabled: true });
  assertEq(c.propose(undefined), undefined);
  assertEq(c.propose({ firstKeptEntryId: 5 as never, tokensBefore: 1 }), undefined);
  assertEq(c.propose({ firstKeptEntryId: "E1", tokensBefore: undefined as never }), undefined);
});

test("fastcompact: setEnabled flips the switch live", () => {
  const c = new FastCompactionController({ enabled: false });
  assertEq(c.propose(prep), undefined);
  c.setEnabled(true);
  assertEq(c.enabled, true);
  assert(c.propose(prep) !== undefined, "proposal after enabling");
  c.setEnabled(false);
  assertEq(c.propose(prep), undefined);
});

test("fastcompact: stats count completed fast compactions", () => {
  const c = new FastCompactionController({ enabled: true });
  assertEq(c.stats().compactions, 0);
  c.recordCompaction();
  c.recordCompaction();
  assertEq(c.stats().compactions, 2);
});

test("fastcompact: branch proposal mirrors pi's summarize guards", () => {
  const c = new FastCompactionController({ enabled: true });
  assertEq(c.proposeBranch(3, false), undefined, "no summary requested");
  assertEq(c.proposeBranch(0, true), undefined, "nothing to summarize");
  const proposal = c.proposeBranch(3, true);
  assert(proposal !== undefined, "branch proposal expected");
  assertEq(proposal!.summary, FAST_BRANCH_STUB);
  assertEq(new FastCompactionController({ enabled: false }).proposeBranch(3, true), undefined);
});
