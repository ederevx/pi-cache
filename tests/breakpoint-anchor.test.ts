/**
 * pi-cache — mid-history breakpoint anchor tests.
 * The anchor spends Anthropic's fourth marker slot on a stable quantum
 * position behind the trailing marker; it must skip cleanly whenever the
 * budget, depth, or explicit-breakpoint preconditions fail, and stay
 * idempotent.
 */

import { test, assert, assertEq } from "./harness.ts";
import { BreakpointAnchor } from "../src/breakpoint-anchor.ts";

const MARKER = { type: "ephemeral" } as const;

/** A payload shaped like pi 0.87's anthropic output: system block, last
 *  tool marker, last-message marker, and `turns` filler messages. */
function payload(turns: number) {
  const messages: Array<{ role: string; content: unknown }> = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `u${i}` }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
  }
  const last = messages[messages.length - 1];
  (last.content as Array<Record<string, unknown>>)[0].cache_control = { ...MARKER };
  return {
    system: [{ type: "text", text: "sys", cache_control: { ...MARKER } }],
    tools: [{ name: "t", input_schema: {}, cache_control: { ...MARKER } }],
    messages,
  };
}

function markerPositions(p: ReturnType<typeof payload>): number[] {
  const positions: number[] = [];
  let seen = 0;
  for (const m of p.messages as Array<{ content: unknown }>) {
    for (const block of m.content as Array<Record<string, unknown>>) {
      seen++;
      if (block.cache_control) positions.push(seen);
    }
  }
  return positions;
}

test("anchor: places one marker behind the trailing window", () => {
  const anchor = new BreakpointAnchor();
  const p = payload(30); // 60 blocks; trailing marker at 60.
  anchor.apply(p);
  const positions = markerPositions(p);
  assertEq(positions.length, 2, "anchor added once");
  // Ceiling 60-20 = 40; the largest multiple of 24 <= 40 is 24.
  assertEq(positions.join(","), "24,60", "quantum-aligned behind the margin");
  const anchorBlock = (
    (p.messages as Array<{ content: Array<Record<string, unknown>> }>)[23].content
  )[0];
  assertEq(JSON.stringify(anchorBlock.cache_control), JSON.stringify(MARKER), "marker value copied");
  assertEq(anchor.count(), 1);
});

test("anchor: idempotent across repeated application", () => {
  const anchor = new BreakpointAnchor();
  const p = payload(30);
  anchor.apply(p);
  const first = markerPositions(p).join(",");
  anchor.apply(p);
  assertEq(markerPositions(p).join(","), first, "no additional marker");
  assertEq(anchor.count(), 1, "placement counted once");
});

test("anchor: skips short histories below the minimum depth", () => {
  const anchor = new BreakpointAnchor();
  const p = payload(5); // 10 blocks total.
  anchor.apply(p);
  assertEq(markerPositions(p).length, 1, "no anchor");
  assertEq(anchor.count(), 0);
});

test("anchor: skips when the marker budget is spent", () => {
  const anchor = new BreakpointAnchor();
  const p = payload(30);
  // A second trailing marker (OAuth-shaped second system block) fills the budget.
  (p.system as Array<Record<string, unknown>>).push({
    type: "text",
    text: "cc",
    cache_control: { ...MARKER },
  });
  anchor.apply(p);
  assertEq(markerPositions(p).length, 1, "no anchor when 4 markers exist");
});

test("anchor: respects explicit mid-history breakpoints", () => {
  const anchor = new BreakpointAnchor();
  const p = payload(30);
  // An explicit marker deep in the history blocks the anchor window.
  (
    (p.messages as Array<{ content: Array<Record<string, unknown>> }>)[10].content
  )[0].cache_control = { ...MARKER };
  anchor.apply(p);
  assertEq(markerPositions(p).length, 2, "explicit marker untouched, no anchor");
  assertEq(anchor.count(), 0);
});

test("anchor: no-op for payloads without message markers", () => {
  const anchor = new BreakpointAnchor();
  const p = payload(30);
  ((p.messages as Array<{ content: Array<Record<string, unknown>> }>)[59].content)[0].cache_control = undefined;
  anchor.apply(p);
  assertEq(anchor.count(), 0, "format not proven without a message marker");
});
