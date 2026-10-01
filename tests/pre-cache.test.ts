/**
 * pi-cache — `pre_cache` onboarding tool tests.
 * Drives PreCacheTool against a fake pi and theme: the catalog contract,
 * tool registration, the first-call gate on owned tools (and only owned
 * tools), the session_start reset + collapse default, and the
 * collapsed-by-default renderResult.
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

const fakeTheme = {
  fg: (_tag: string, text: string) => text,
  bold: (text: string) => text,
};

function render(
  tool: Record<string, unknown>,
  result: unknown,
  expanded: boolean,
): string {
  const renderResult = tool.renderResult as (
    r: unknown,
    options: { expanded: boolean },
    theme: typeof fakeTheme,
  ) => { render(width: number): string[] };
  return renderResult(result, { expanded }, fakeTheme).render(200).join("\n");
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

test("pre-cache: registers the tool, the gate, and the collapse hook", () => {
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

test("pre-cache: session_start resets the gate and collapses tools", async () => {
  const pi = new FakePi();
  const tool = new PreCacheTool(["cache_probe"]);
  tool.register(pi as never);
  await pi.emit("tool_call", { toolName: "pre_cache" });

  const calls: boolean[] = [];
  await pi.emit(
    "session_start",
    { reason: "new" },
    { hasUI: true, ui: { setToolsExpanded: (value: boolean) => calls.push(value) } },
  );
  assertEq(calls.length, 1, "collapse default applied once");
  assertEq(calls[0], false, "tools collapsed by default");

  const [blocked] = (await pi.emit("tool_call", { toolName: "cache_probe" })) as Array<{
    block?: boolean;
  }>;
  assertEq(blocked?.block, true, "gate closed again for the new session");
});

test("pre-cache: session_start with no UI skips the collapse call", async () => {
  const pi = new FakePi();
  new PreCacheTool().register(pi as never);
  await pi.emit("session_start", { reason: "new" }, { hasUI: false, ui: {} });
  assertEq(pi.handlers.get("session_start")?.length, 1, "hook ran without throwing");
});

test("pre-cache: execute returns the catalog and renderResult collapses", async () => {
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

  const collapsed = render(tool, result, false);
  assertMatches(collapsed, /Ctrl\+O to expand/, "collapsed shows the expand hint");
  assert(!collapsed.includes("pi-cache catalog"), "collapsed hides the catalog");
  const expanded = render(tool, result, true);
  assertMatches(expanded, /pi-cache catalog/, "expanded shows the catalog");
});
