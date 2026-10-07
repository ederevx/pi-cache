/**
 * pi-cache — kept-window limiter tests.
 *
 * pi's cut keeps a verbatim window near `keepRecentTokens`, but one entry
 * larger than that budget forces the cut before it, so the entry survives
 * every compaction. The limiter must advance the cut (or keep nothing),
 * while never opening the window on an orphaned tool result.
 */

import { test, assert, assertEq } from "./harness.ts";
import { KeptWindowLimiter } from "../src/kept-window.ts";

type Message = { role: string; content?: unknown; [key: string]: unknown };

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResult(text: string): Message {
  return { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text }] };
}

function projected(id: string, message: Message) {
  return {
    sourceEntry: {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    },
    messages: [message],
  };
}

/** A projected entry with no context-visible messages (omitted edit/advisory). */
function hidden(id: string) {
  return {
    sourceEntry: {
      type: "custom",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "pi-cache-advisory",
      data: {},
    },
    messages: [] as Message[],
  };
}

const limiter = new KeptWindowLimiter(4);

test("kept-window: missing entries or an unknown cut leaves pi's cut alone", () => {
  assertEq(limiter.limit(undefined, "e1", 100).firstKeptEntryId, "e1");
  assertEq(limiter.limit([], "e1", 100).firstKeptEntryId, "e1");
  const entries = [projected("e1", user("x"))];
  assertEq(limiter.limit(entries as never, "nope", 100).firstKeptEntryId, "nope");
});

test("kept-window: a window inside the cap is untouched", () => {
  const entries = [
    projected("e1", user("x".repeat(400))),
    projected("e2", assistant("y".repeat(400))),
  ];
  const plan = limiter.limit(entries as never, "e2", 100);
  assertEq(plan.firstKeptEntryId, "e2");
  assertEq(plan.extraDropped.length, 0);
});

test("kept-window: an oversized entry advances the cut past it", () => {
  // e2 spans ~2500 tokens, far above the 4x cap of this 100-token budget.
  const entries = [
    projected("e1", user("old")),
    projected("e2", assistant("x".repeat(10_000))),
    projected("e3", user("new request")),
  ];
  const plan = limiter.limit(entries as never, "e2", 100);
  assertEq(plan.firstKeptEntryId, "e3", "advances to the next turn start");
  assertEq(plan.extraDropped.length, 1, "the oversized assistant is re-dropped");
});

test("kept-window: an orphaned tool result never opens the window", () => {
  const entries = [
    projected("e1", user("old")),
    projected("e2", assistant("x".repeat(10_000))),
    projected("e3", toolResult("huge")),
    projected("e4", user("next")),
  ];
  const plan = limiter.limit(entries as never, "e2", 100);
  // e3 is a tool result, so the safe start is e4.
  assertEq(plan.firstKeptEntryId, "e4");
});

test("kept-window: keep nothing when the tail is one oversized entry", () => {
  const entries = [
    projected("e1", user("old")),
    projected("e2", assistant("x".repeat(10_000))),
  ];
  const plan = limiter.limit(entries as never, "e2", 100);
  assertEq(plan.firstKeptEntryId, "pi-cache-keep-none", "no entry kept");
  assertEq(plan.extraDropped.length, 1, "dropped messages recorded");
});

test("kept-window: a hidden boundary is a safe, empty start", () => {
  const entries = [
    projected("e1", user("old")),
    projected("e2", assistant("x".repeat(10_000))),
    projected("e3", toolResult("huge result")),
    hidden("e4"),
  ];
  const plan = limiter.limit(entries as never, "e2", 100);
  assertEq(plan.firstKeptEntryId, "e4", "hidden boundary keeps no messages");
  assert(plan.extraDropped.length >= 1, "oversized messages recorded");
});

test("kept-window: a non-positive keep-recent budget disables the cap", () => {
  const entries = [projected("e1", assistant("x".repeat(10_000)))];
  assertEq(limiter.limit(entries as never, "e1", 0).firstKeptEntryId, "e1");
});
