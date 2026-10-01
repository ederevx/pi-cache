/**
 * pi-cache — `pre_cache` onboarding tool tests.
 * Drives PreCacheTool against a fake pi: the catalog contract, tool
 * registration, the first-call gate on owned tools (and only owned
 * tools), and the session_start reset. The tool defines no custom
 * renderer, so pi's native collapsed rendering applies.
 */

import { test, assert, assertEq, assertMatches } from "./harness.ts";
import { PreCacheTool } from "../src/pre-cache.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  tool?: Record<string, unknown>;

  on(name: string, handler: Handler): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  registerTool(def: { name: string } & Record<string, unknown>): void {
    this.tool = def;
  }

  async emit(name: string, event: unknown, ctx?: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(name) ?? []) {
      results.push(await handler(event, ctx));
    }
    return results;
  }
}

test("pre-cache: catalog states tools, conventions, and features", () => {
  const catalog = new PreCacheTool().catalog();
  assertMatches(catalog, /Model-callable tools: none/, "declares no model tools");
  assertMatches(catalog, /\/cache-stats/, "names the stats command");
  assertMatches(catalog, /\/cache-settings/, "names the settings command");
  assertMatches(catalog, /Conventions:/, "has a conventions section");
  assertMatches(catalog, /Features:/, "has a features section");
  assertMatches(catalog, /fast compaction/i, "names fast compaction");
  assertMatches(catalog, /warming/i, "names warming");
});

test("pre-cache: registers the tool and the gate", () => {
  const pi = new FakePi();
  new PreCacheTool().register(pi as never);
  assert(pi.tool !== undefined, "pre_cache tool registered");
  assertEq(pi.tool?.name, "pre_cache", "tool name");
  assertEq(pi.handlers.get("tool_call")?.length, 1, "one tool_call gate");
  assertEq(pi.handlers.get("session_start")?.length, 1, "one session_start hook");
});

test("pre-cache: gate blocks owned tools until pre_cache is called", async () => {
  const pi = new FakePi();
  const tool = new PreCacheTool(["cache_probe"]);
  tool.register(pi as never);

  const [before] = (await pi.emit("tool_call", { toolName: "cache_probe" })) as Array<{
    block?: boolean;
    reason?: string;
  }>;
  assertEq(before?.block, true, "owned tool blocked before acknowledgment");
  assertMatches(before?.reason ?? "", /pre_cache/, "block reason names the tool");

  const [foreign] = (await pi.emit("tool_call", { toolName: "read" })) as unknown[];
  assertEq(foreign, undefined, "foreign tool is never blocked");

  await pi.emit("tool_call", { toolName: "pre_cache" });
  const [after] = (await pi.emit("tool_call", { toolName: "cache_probe" })) as unknown[];
  assertEq(after, undefined, "owned tool allowed after the catalog call");
});

test("pre-cache: gate stays open when the extension owns no tools", async () => {
  const pi = new FakePi();
  new PreCacheTool().register(pi as never);
  const [result] = (await pi.emit("tool_call", { toolName: "cache_probe" })) as unknown[];
  assertEq(result, undefined, "unknown owned tool is not blocked");
});

test("pre-cache: session_start resets the gate", async () => {
  const pi = new FakePi();
  const tool = new PreCacheTool(["cache_probe"]);
  tool.register(pi as never);
  await pi.emit("tool_call", { toolName: "pre_cache" });

  await pi.emit("session_start", { reason: "new" });
  const [blocked] = (await pi.emit("tool_call", { toolName: "cache_probe" })) as Array<{
    block?: boolean;
  }>;
  assertEq(blocked?.block, true, "gate closed again for the new session");
});

test("pre-cache: execute returns the catalog and defines no custom renderer", async () => {
  const pi = new FakePi();
  new PreCacheTool().register(pi as never);
  const tool = pi.tool as Record<string, unknown>;
  const result = (await (tool.execute as () => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>)()) as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  };
  assertMatches(result.content[0].text, /pi-cache catalog/, "execute returns catalog");
  assert("conventions" in result.details, "details carry conventions");
  assert("features" in result.details, "details carry features");

  assertEq(tool.renderResult, undefined, "no custom result renderer");
  assertEq(tool.renderCall, undefined, "no custom call renderer");
});
