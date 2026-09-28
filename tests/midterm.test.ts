/**
 * pi-cache — midterm compaction tests.
 *
 * Covers the cut planner (the exported `findCutPoint` wrapper that mirrors
 * pi's `prepareCompaction`) and the draft builder that composes the
 * fast-compaction summary into a boundary `compaction` draft.
 */

import { test, assert, assertEq } from "./harness.ts";
import { MidtermCutPlanner } from "../src/midterm-cut.ts";
import { MidtermCompactor } from "../src/midterm.ts";
import { FastCompactionController, FAST_SUMMARY_STUB } from "../src/fastcompact.ts";

type Message = { role: string; content?: unknown; [key: string]: unknown };

function message(role: string, text: string): Message {
  if (role === "assistant") {
    return { role, content: [{ type: "text", text }] };
  }
  if (role === "toolResult") {
    return { role, toolCallId: "t1", content: [{ type: "text", text }] };
  }
  return { role, content: [{ type: "text", text }] };
}

function projected(id: string, role: string, text: string) {
  const msg = message(role, text);
  return {
    sourceEntry: {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: msg,
    },
    messages: [msg],
  };
}

function fastController(enabled = true, digest = false): FastCompactionController {
  return new FastCompactionController({ enabled, branchEnabled: false, digestEnabled: digest });
}

test("midterm: cut planner keeps recent and summarizes the older span", () => {
  const planner = new MidtermCutPlanner(1);
  const entries = [projected("e1", "assistant", "old"), projected("e2", "user", "new")];
  const plan = planner.plan(entries as never, 1234);
  assert(plan !== undefined, "planned");
  assertEq(plan!.firstKeptEntryId, "e2");
  assertEq(plan!.isSplitTurn, false, "cut at a user turn start");
  assertEq(plan!.messagesToSummarize.length, 1, "older assistant summarized");
  assertEq(plan!.tokensBefore, 1234);
});

test("midterm: cut planner returns undefined when nothing precedes the cut", () => {
  const planner = new MidtermCutPlanner(100000);
  const entries = [projected("e1", "user", "only")];
  assertEq(planner.plan(entries as never, 10), undefined);
});

test("midterm: cut planner folds the previous compaction summary", () => {
  const planner = new MidtermCutPlanner(1);
  const compaction = {
    sourceEntry: {
      type: "compaction",
      id: "c1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "prior summary",
      firstKeptEntryId: "e1",
      tokensBefore: 10,
    },
    messages: [{ role: "compactionSummary", summary: "prior summary", tokensBefore: 10, timestamp: 1 }],
  };
  const entries = [
    compaction,
    projected("e1", "assistant", "old"),
    projected("e2", "user", "new"),
  ];
  const plan = planner.plan(entries as never, 5);
  assert(plan !== undefined, "planned");
  assertEq(plan!.previousSummary, "prior summary");
});

test("midterm: draft uses the fast summary when fast compaction is on", () => {
  const compactor = new MidtermCompactor(fastController(true), new MidtermCutPlanner(1));
  const projection = {
    entries: [projected("e1", "assistant", "old"), projected("e2", "user", "new")],
    messages: [message("assistant", "old"), message("user", "new")],
  };
  const draft = compactor.draft(
    { sessionManager: { buildSessionProjection: () => projection, getSessionFile: () => "/x/s.jsonl" } },
    42,
  );
  assert(draft !== undefined, "draft built");
  assertEq(draft!.type, "compaction");
  assertEq(draft!.firstKeptEntryId, "e2");
  assert(draft!.summary.startsWith(FAST_SUMMARY_STUB), "fast stub first");
  assert(draft!.summary.includes("/x/s.jsonl"), "transcript pointer present");
});

test("midterm: draft is undefined when fast compaction is off", () => {
  const compactor = new MidtermCompactor(fastController(false), new MidtermCutPlanner(1));
  const projection = {
    entries: [projected("e1", "assistant", "old"), projected("e2", "user", "new")],
    messages: [message("assistant", "old"), message("user", "new")],
  };
  assertEq(
    compactor.draft({ sessionManager: { buildSessionProjection: () => projection } }, 42),
    undefined,
  );
});

test("midterm: draft tolerates a missing session manager", () => {
  const compactor = new MidtermCompactor(fastController(true), new MidtermCutPlanner(1));
  assertEq(compactor.draft(undefined), undefined);
  assertEq(compactor.draft({ sessionManager: {} }), undefined);
});
