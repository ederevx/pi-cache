/**
 * pi-cache — fast compaction override tests.
 * propose() must emit the byte-stable stub at pi's own cut point when
 * enabled, and must return undefined (leaving pi's summarizer intact) when
 * disabled or given a malformed preparation. The branch-summary switch is
 * independent of the compaction switch.
 */

import { test, assert, assertEq } from "./harness.ts";
import { FastCompactionController, FAST_BRANCH_STUB, FAST_SUMMARY_STUB } from "../src/fastcompact.ts";

const prep = { firstKeptEntryId: "E42", tokensBefore: 123_456 };

/** The default controller: fast compaction + digest on. */
const digested = (
  opts: Partial<ConstructorParameters<typeof FastCompactionController>[0]> = {},
): FastCompactionController =>
  new FastCompactionController({
    enabled: true,
    branchEnabled: false,
    digestEnabled: true,
    ...opts,
  });

/** A dropped span of roughly `tokens` tokens (one long user message). */
const spanOfTokens = (tokens: number): unknown[] => [
  { role: "user", content: "x".repeat(Math.max(0, tokens * 4 - 2)) },
];

test("fastcompact: disabled proposes nothing", () => {
  const c = new FastCompactionController({ enabled: false, branchEnabled: false });
  assertEq(c.propose(prep), undefined);
});

test("fastcompact: enabled proposes the byte-stable stub at pi's cut", () => {
  const c = new FastCompactionController({ enabled: true, branchEnabled: true });
  const proposal = c.propose(prep);
  assert(proposal !== undefined, "proposal expected");
  assertEq(proposal!.summary, FAST_SUMMARY_STUB);
  assertEq(proposal!.firstKeptEntryId, "E42");
  assertEq(proposal!.tokensBefore, 123_456);
});

test("fastcompact: digest enabled appends the span record after the stub", () => {
  const c = digested();
  const full = {
    ...prep,
    messagesToSummarize: [
      { role: "user", content: "fix the bug in src/a.ts" },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }] },
    ],
    fileOps: { read: new Set(["src/a.ts"]), edited: new Set(["src/a.ts"]) },
  };
  const proposal = c.propose(full);
  assert(proposal !== undefined, "proposal expected");
  assert(proposal!.summary.startsWith(FAST_SUMMARY_STUB), "stub first: shared head intact");
  assert(proposal!.summary.includes("Files modified: src/a.ts"), "file record kept");
  assert(proposal!.summary.includes("U: fix the bug in src/a.ts"), "turn record kept");
  assert(proposal!.summary.includes("tools: edit"), "tool names kept");
});

test("fastcompact: digest off keeps the exact legacy stub without a session file", () => {
  const c = digested({ digestEnabled: false });
  const proposal = c.propose({ ...prep, messagesToSummarize: [{ role: "user", content: "hi" }] });
  assert(proposal !== undefined, "proposal expected");
  assertEq(proposal!.summary, FAST_SUMMARY_STUB);
});

test("fastcompact: transcript pointer names session file and boundary", () => {
  const c = digested();
  const full = {
    ...prep,
    messagesToSummarize: [{ role: "user", content: "hello" }],
    fileOps: { read: new Set(["a.ts"]) },
  };
  const withFile = c.propose(full, "/x/s1.jsonl");
  assert(withFile !== undefined, "proposal expected");
  assert(withFile!.summary.startsWith(FAST_SUMMARY_STUB), "stub first");
  assert(withFile!.summary.includes("/x/s1.jsonl"), "session file named");
  assert(withFile!.summary.includes("entries before E42"), "boundary entry named");
  assert(withFile!.summary.includes("grep -m 5"), "bounded recall suggested");
  assert(withFile!.summary.indexOf("</pi-cache-digest>") < withFile!.summary.indexOf("Full pre-compaction transcript"), "pointer after digest");

  // Pointer stands alone when the digest is off or empty.
  const bare = digested({ digestEnabled: false }).propose(full, "/x/s2.jsonl");
  assert(bare !== undefined, "proposal expected");
  assertEq(bare!.summary, `${FAST_SUMMARY_STUB}\n\nFull pre-compaction transcript: /x/s2.jsonl — entries before E42 were dropped by this compaction and remain readable there. Recall with a bounded search, e.g. grep -m 5 '<term>' /x/s2.jsonl; never read the file whole.`);

  // No session file: pointer is omitted entirely (legacy stub).
  const noFile = c.propose(full);
  assert(noFile !== undefined, "proposal expected");
  assert(!noFile!.summary.includes("transcript"), "no pointer without a session file");
});

test("fastcompact: enforced for spans of any size", () => {
  const c = digested();
  const proposal = c.propose({ ...prep, messagesToSummarize: spanOfTokens(100_000) });
  assert(proposal !== undefined, "huge span still fast-compacted");
  assert(proposal!.summary.startsWith(FAST_SUMMARY_STUB), "stub first");
  // Split-turn prefixes are enforced too, not gated.
  const split = c.propose({
    ...prep,
    messagesToSummarize: spanOfTokens(60_000),
    isSplitTurn: true,
    turnPrefixMessages: spanOfTokens(42_000),
  });
  assert(split !== undefined, "split-turn span still fast-compacted");
});

test("fastcompact: digest accumulates across compactions via previousSummary", () => {
  const c = digested();
  const priorSummary = `${FAST_SUMMARY_STUB}\n\n<pi-cache-digest>\nFiles read: old.ts\n- U: earlier work\n</pi-cache-digest>`;
  const proposal = c.propose({
    ...prep,
    messagesToSummarize: [{ role: "user", content: "next task in src/b.ts" }],
    previousSummary: priorSummary,
    fileOps: { read: new Set(["src/b.ts"]) },
  });
  assert(proposal !== undefined, "proposal expected");
  const summary = proposal!.summary;
  const priorIdx = summary.indexOf("earlier work");
  const newIdx = summary.indexOf("next task in src/b.ts");
  assert(priorIdx !== -1 && newIdx !== -1, "both generations present");
  assert(priorIdx < newIdx, "prior block precedes the new one");
  assert(summary.indexOf("old.ts") < summary.indexOf("src/b.ts"), "file record order");
});

test("fastcompact: digest switch toggles live", () => {
  const c = digested();
  assertEq(c.digestEnabled, true);
  const full = { ...prep, messagesToSummarize: [{ role: "user", content: "hello" }] };
  assert(c.propose(full)!.summary.includes("U: hello"), "digest on records the turn");
  c.setDigestEnabled(false);
  assertEq(c.propose(full)!.summary, FAST_SUMMARY_STUB);
  c.setDigestEnabled(true);
  assert(c.propose(full)!.summary.includes("U: hello"), "digest back on");
});

test("fastcompact: malformed preparation fails open", () => {
  const c = new FastCompactionController({ enabled: true, branchEnabled: true });
  assertEq(c.propose(undefined), undefined);
  assertEq(c.propose({ firstKeptEntryId: 5 as never, tokensBefore: 1 }), undefined);
  assertEq(c.propose({ firstKeptEntryId: "E1", tokensBefore: undefined as never }), undefined);
});

test("fastcompact: setEnabled flips the switch live", () => {
  const c = new FastCompactionController({ enabled: false, branchEnabled: false });
  assertEq(c.propose(prep), undefined);
  c.setEnabled(true);
  assertEq(c.enabled, true);
  assert(c.propose(prep) !== undefined, "proposal after enabling");
  c.setEnabled(false);
  assertEq(c.propose(prep), undefined);
});

test("fastcompact: stats count completed fast compactions", () => {
  const c = new FastCompactionController({ enabled: true, branchEnabled: true });
  assertEq(c.stats().compactions, 0);
  c.recordCompaction();
  c.recordCompaction();
  assertEq(c.stats().compactions, 2);
});

test("fastcompact: branch proposal mirrors pi's summarize guards", () => {
  const c = new FastCompactionController({ enabled: true, branchEnabled: true });
  assertEq(c.proposeBranch(3, false), undefined, "no summary requested");
  assertEq(c.proposeBranch(0, true), undefined, "nothing to summarize");
  const proposal = c.proposeBranch(3, true);
  assert(proposal !== undefined, "branch proposal expected");
  assertEq(proposal!.summary, FAST_BRANCH_STUB);
  assertEq(
    new FastCompactionController({ enabled: false, branchEnabled: false }).proposeBranch(3, true),
    undefined,
  );
});

test("fastcompact: the branch switch is independent of compaction", () => {
  const c = new FastCompactionController({ enabled: true, branchEnabled: false });
  assertEq(c.branchEnabled, false);
  assertEq(c.proposeBranch(3, true), undefined, "branch override off");
  assert(c.propose({ firstKeptEntryId: "E1", tokensBefore: 1 }) !== undefined, "compaction still on");
  c.setBranchEnabled(true);
  assertEq(c.branchEnabled, true);
  assert(c.proposeBranch(3, true) !== undefined, "branch override on after enabling");
  c.setBranchEnabled(false);
  assertEq(c.branchEnabled, false);
});