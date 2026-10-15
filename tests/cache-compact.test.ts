/**
 * pi-cache — cache_compact tool tests.
 * The tool owns exactly one queued explicit request: it reports the
 * draw-free cache state, rejects an empty reason, coalesces duplicate calls
 * in one run, and hands the pending request to the settled boundary. It
 * never calls ctx.compact() itself.
 */

import { test, assert, assertEq, assertMatches } from "./harness.ts";
import { CacheCompactTool } from "../src/cache-compact.ts";
import type { CacheStateSnapshot } from "../src/cache-state.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, Record<string, unknown>>();

  on(name: string, handler: Handler): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  registerTool(def: { name: string } & Record<string, unknown>): void {
    this.tools.set(def.name, def);
  }
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function snapshot(overrides: Partial<CacheStateSnapshot> = {}): CacheStateSnapshot {
  return {
    global: { n: 3, input: 100, cacheRead: 900, cacheWrite: 10 },
    session: { n: 1, input: 10, cacheRead: 90, cacheWrite: 5 },
    context: { tokens: 60_000, contextWindow: 200_000, percent: 30 },
    pressure: { pressure: 0.4, probability: 0.2 },
    autoEnabled: true,
    fastEnabled: true,
    telemetryEnabled: true,
    ...overrides,
  };
}

function makeTool(state: Partial<CacheStateSnapshot> = {}) {
  const reader = { read: () => snapshot(state) };
  const tool = new CacheCompactTool(reader as never);
  const pi = new FakePi();
  tool.register(pi as never);
  const def = pi.tools.get("cache_compact");
  assert(def !== undefined, "cache_compact registered");
  return { tool, pi, def: def as Record<string, unknown> };
}

async function run(def: Record<string, unknown>, reason: unknown): Promise<ToolResult> {
  const execute = def.execute as (
    id: string,
    params: { reason?: unknown },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<ToolResult>;
  return execute("call-1", { reason }, undefined, undefined, {});
}

test("cache-compact: registers the tool with the destructive annotation", () => {
  const { pi } = makeTool();
  const def = pi.tools.get("cache_compact") as Record<string, unknown>;
  assertEq(def.name, "cache_compact", "tool name");
  assertMatches(String(def.description), /pre_cache/, "points at the onboarding gate");
  const annotations = def.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean };
  assertEq(annotations.readOnlyHint, false, "not read-only");
  assertEq(annotations.destructiveHint, true, "context-destructive");
});

test("cache-compact: queues one request and coalesces duplicates", async () => {
  const { tool, def } = makeTool();
  assertEq(tool.takeForSettlement(), undefined, "nothing queued before a call");
  const first = await run(def, "switch to the new task");
  assertEq(first.details.requested, true, "first call requests");
  assertEq(first.details.duplicate, false, "first call is not a duplicate");
  const pending = tool.takeForSettlement();
  assert(pending !== undefined, "request queued");
  assertEq(pending!.reason, "switch to the new task");
  const second = await run(def, "another reason");
  assertEq(second.details.duplicate, true, "second call coalesces");
  assertEq(tool.takeForSettlement()!.reason, "switch to the new task", "original reason stands");
});

test("cache-compact: an empty reason rejects without queueing", async () => {
  const { tool, def } = makeTool();
  const result = await run(def, "   ");
  assertEq(result.isError, true, "empty reason is a tool error");
  assertEq(result.details.requested, false, "no request was made");
  assertEq(tool.takeForSettlement(), undefined, "nothing queued");
});

test("cache-compact: the receipt reports the draw-free cache state", async () => {
  const { def } = makeTool();
  const result = await run(def, "context switch");
  const text = result.content[0].text;
  assertMatches(text, /request queued/, "states the request");
  assertMatches(text, /global \(all time\): 3 req/, "global lifetime scope");
  assertMatches(text, /session: 1 req/, "session scope");
  assertMatches(text, /pressure 0\.40 \(p 20%\)/, "pressure preview");
  assertMatches(text, /auto-compaction on; fast compaction on; telemetry on/, "live switches");
});

test("cache-compact: unavailable context and pressure render explicitly", async () => {
  const { def } = makeTool({ context: undefined, pressure: undefined });
  const result = await run(def, "no sample");
  assertMatches(result.content[0].text, /context: unavailable/, "context unavailable");
  assertMatches(result.content[0].text, /pressure: unavailable/, "pressure unavailable");
});

test("cache-compact: finish and reset clear the queued request", async () => {
  const { tool, def } = makeTool();
  await run(def, "switch");
  tool.finish(true);
  assertEq(tool.takeForSettlement(), undefined, "finish consumes the request");
  await run(def, "switch again");
  tool.reset();
  assertEq(tool.takeForSettlement(), undefined, "reset drops session state");
});
