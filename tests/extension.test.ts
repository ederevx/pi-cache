/**
 * pi-cache — end-to-end extension wiring tests.
 * Loads the real index.ts factory against a mock pi and drives the event
 * surface: ledger telemetry, prefix normalization + churn, session
 * pinning, the default cold-window auto-compaction, the warm-cache
 * advisory, and the commands. Everything is fail-open; odd events must
 * never throw.
 */

import {
  test,
  assert,
  assertEq,
  assertMatches,
  assertJsonLine,
  scratchDir,
  waitFor,
} from "./harness.ts";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { FAST_BRANCH_STUB, FAST_SUMMARY_STUB } from "../src/fastcompact.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

class MockPi {
  readonly handlers = new Map<string, Handler[]>();
  readonly entries: Array<{ kind: string; data: unknown }> = [];
  readonly commands = new Map<string, { description: string; handler: Handler }>();

  on(name: string, handler: Handler): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  appendEntry(kind: string, data: unknown): void {
    this.entries.push({ kind, data });
  }

  registerCommand(
    name: string,
    def: { description: string; handler: Handler },
  ): void {
    this.commands.set(name, def);
  }

  /** Run every handler for `name` in order; returns their results. */
  async emit(name: string, event: unknown, ctx: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(name) ?? []) {
      results.push(await handler(event, ctx));
    }
    return results;
  }
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const compactCalls: Array<Record<string, unknown>> = [];
  const ctx = {
    getContextUsage: () => ({ percent: 85, tokens: 60_000 }),
    sessionManager: {
      getSessionId: () => "sess1",
      getSessionFile: () => "/x/s1.jsonl",
    },
    compact: (args: Record<string, unknown>) => {
      compactCalls.push(args);
    },
    ...overrides,
  };
  return { ctx, compactCalls };
}

function setEnv(overrides: Record<string, string>): void {
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

function unsetEnv(keys: string[]): void {
  for (const key of keys) delete process.env[key];
}

const PI_CACHE_KEYS = [
  "PI_CACHE_TELEMETRY",
  "PI_CACHE_DEDUP_TOOLS",
  "PI_CACHE_ANCHOR",
  "PI_CACHE_RETENTION_OVERRIDE",
  "PI_CACHE_CANONICALIZE",
  "PI_CACHE_SHARED_KEY",
  "PI_CACHE_FORCE_WARM",
  "PI_CACHE_ADVISORY",
  "PI_CACHE_AUTO_COMPACT",
  "PI_CACHE_IDLE_TRIGGER",
  "PI_CACHE_BEFORE_TURN",
  "PI_CACHE_FAST_COMPACT",
  "PI_CACHE_FAST_BRANCH_SUMMARY",
  "PI_CACHE_LEDGER",
  "PI_CACHE_SETTINGS",
];

function assertToolNames(tools: Array<{ name: string }>, expected: string[]): void {
  assertEq(tools.length, expected.length, "tool count");
  for (let i = 0; i < expected.length; i++) {
    assertEq(tools[i].name, expected[i], `tool[${i}]`);
  }
}

test("extension: default cold-window auto-compaction lifecycle", async () => {
  const root = join(scratchDir(), "e2e");
  mkdirSync(root, { recursive: true });
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: join(root, "settings.json"),
    PI_CACHE_FAST_COMPACT: "1",
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);

    assert(pi.commands.has("cache-stats"), "/cache-stats registered");
    assert(pi.commands.has("cache-settings"), "/cache-settings registered");

    // 1. Cold turn: ~0 cacheRead -> ledger row.
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          usage: { input: 1000, output: 50, cacheRead: 5, cacheWrite: 950, totalTokens: 2005 },
        },
      },
      { model: { id: "m1" } },
    );
    await waitFor(() => existsSync(join(root, "ledger.jsonl")), "ledger persisted");
    const ledgerLines = readFileSync(join(root, "ledger.jsonl"), "utf8").trimEnd().split("\n");
    assertEq(ledgerLines.length, 1);
    const row = assertJsonLine(ledgerLines[0]);
    assertEq(row.model, "m1");
    assertEq(row.cacheRead, 5);

    // 2. Prefix-head churn: two different models -> churn signal.
    const payloadA = {
      model: "model-a",
      messages: [{ role: "system", content: "sys" }],
      // Duplicates exercise the dedup transform; order is preserved.
      tools: [{ name: "z", description: "z" }, { name: "a", description: "a" }, { name: "z", description: "z" }],
    };
    const [normalizedA] = await pi.emit("before_provider_request", { payload: payloadA }, {});
    assertEq(normalizedA, payloadA, "same object reference returned");
    assertToolNames((normalizedA as { tools: Array<{ name: string }> }).tools, ["z", "a"]);

    await pi.emit("before_provider_request", { payload: { ...payloadA, model: "model-b" } }, {});

    // 3. turn_end + agent_settled: cold + churned + context 85% -> compact.
    const { ctx, compactCalls } = makeCtx();
    await pi.emit("turn_end", { turnIndex: 0 }, {});
    await pi.emit("agent_settled", {}, ctx);
    assertEq(compactCalls.length, 1, "cold+churned window compacts");
    const call = compactCalls[0];
    assert(typeof call.onError === "function", "onError callback bound");

    // 4. Compaction telemetry: pi's normal compaction completes.
    await pi.emit(
      "session_compact",
      { compactionEntry: { firstKeptEntryId: "E1", tokensBefore: 60_000, fromHook: true } },
      ctx,
    );
    const compEntry = pi.entries.find((e) => e.kind === "pi-cache-compaction");
    assert(compEntry !== undefined, "compaction telemetry appended");
    assertEq((compEntry.data as { keptEntryId: string }).keptEntryId, "E1");
    assertEq((compEntry.data as { fromExtension: boolean }).fromExtension, true);

    // 4b. Fast compaction override: with the switch on, any compaction
    // result is replaced by the byte-stable stub at pi's own cut point.
    const compactResults = await pi.emit(
      "session_before_compact",
      {
        preparation: { firstKeptEntryId: "E9", tokensBefore: 50_000, messagesToSummarize: [] },
        reason: "threshold",
      },
      ctx,
    );
    const fast = compactResults[0] as { compaction?: { summary: string; firstKeptEntryId: string } } | undefined;
    assert(fast?.compaction !== undefined, "fast override returned a compaction");
    assert(fast!.compaction!.summary.startsWith(FAST_SUMMARY_STUB), "stub first");
    assert(fast!.compaction!.summary.includes("entries before E9"), "transcript pointer present");
    assertEq(fast!.compaction!.firstKeptEntryId, "E9");

    // 4c. Fast branch-summary override: a /tree navigation that wants a
    // summary is replaced by the byte-stable branch stub, and none is
    // offered when the user did not ask for one.
    const treeResults = await pi.emit(
      "session_before_tree",
      { preparation: { userWantsSummary: true, entriesToSummarize: [{}, {}] } },
      ctx,
    );
    const tree = treeResults[0] as { summary?: { summary: string } } | undefined;
    assert(tree?.summary !== undefined, "fast branch summary returned");
    assertEq(tree!.summary!.summary, FAST_BRANCH_STUB);
    const noSummary = await pi.emit(
      "session_before_tree",
      { preparation: { userWantsSummary: false, entriesToSummarize: [{}, {}] } },
      ctx,
    );
    assertEq(noSummary[0], undefined, "no branch summary when not requested");

    // 5. /cache-stats reflects global + session ledger, live pressure,
    // churn, and compaction counts.
    let notified = "";
    const statsCtx = {
      getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000, percent: 60 }),
      ui: { notify: (text: string) => { notified = text; } },
    };
    await pi.commands.get("cache-stats")!.handler([], statsCtx as never);
    assert(notified.includes("pi-cache global: 1 req"), "global stats: " + notified);
    assert(notified.includes("pi-cache session: 1 req"), "session stats: " + notified);
    assert(notified.includes("pressure "), "session pressure: " + notified);
    assert(notified.includes("head churn 1"), "stats reports churn: " + notified);
    assert(notified.includes("compactions 1"), "stats reports compact count: " + notified);

    // 6. /cache-settings renders the two-column custom view.
    let customCalled = false;
    let renderedText = "";
    const settingsCtx = {
      ui: {
        custom: async (factory: (tui: unknown, theme: { fg: (c: string, t: string) => string }, kb: unknown, done: () => void) => { render(w: number): string[] }) => {
          customCalled = true;
          const component = factory({}, { fg: (_c, t) => t }, {}, () => {});
          renderedText = component.render(80).join("\n");
        },
      },
      mode: "tui",
    };
    await pi.commands.get("cache-settings")!.handler([], settingsCtx as never);
    assert(customCalled, "the two-column custom view was requested");
    assert(renderedText.includes("Fast compaction"), "renders the fast-compaction row");
    assert(renderedText.includes("Telemetry"), "renders the option rows");

    // 7. Fail-open: garbage events never throw.
    await pi.emit("message_end", null, null);
    const [nullResult] = await pi.emit("before_provider_request", { payload: null }, {});
    assertEq(nullResult, null);
    await pi.emit("agent_settled", {}, {});
    await pi.emit("session_before_compact", { preparation: undefined }, {});
    await pi.emit("session_compact", null, {});
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: async auto-compact failure is fail-open", async () => {
  const root = join(scratchDir(), "e2e-failopen");
  mkdirSync(root, { recursive: true });
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: join(root, "settings.json"),
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    const { ctx, compactCalls } = makeCtx();
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          usage: { input: 1000, output: 50, cacheRead: 5, cacheWrite: 950, totalTokens: 2000 },
        },
      },
      { model: { id: "m1" } },
    );
    await pi.emit("turn_end", { turnIndex: 0 }, {});
    await pi.emit("agent_settled", {}, ctx);
    assertEq(compactCalls.length, 1, "cold context requests compaction");
    // pi invokes onError asynchronously after the handler returns; appending
    // to a stale extension ctx must not crash the process.
    pi.appendEntry = () => {
      throw new Error("extension ctx is stale");
    };
    const onError = compactCalls[0].onError as () => void;
    onError();
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: settings dismissal stays silent", async () => {
  const root = join(scratchDir(), "e2e-settings-dismiss");
  mkdirSync(root, { recursive: true });
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: join(root, "settings.json"),
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    let errored = false;
    const original = console.error;
    console.error = () => {
      errored = true;
    };
    try {
      await pi.commands.get("cache-settings")!.handler([], {
        ui: { custom: () => Promise.resolve(undefined) },
        mode: "tui",
      } as never);
    } finally {
      console.error = original;
    }
    assertEq(errored, false, "a dismissed view prints nothing");
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: settings custom-view failure falls back to the listing", async () => {
  const root = join(scratchDir(), "e2e-settings-throw");
  mkdirSync(root, { recursive: true });
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: join(root, "settings.json"),
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    let printed = false;
    const original = console.error;
    console.error = () => {
      printed = true;
    };
    try {
      await pi.commands.get("cache-settings")!.handler([], {
        ui: { custom: () => Promise.reject(new Error("no view")) },
        mode: "tui",
      } as never);
    } finally {
      console.error = original;
    }
    assertEq(printed, true, "a throwing view falls back to the listing");
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: input defers a cold prompt until compaction completes", async () => {
  const root = join(scratchDir(), "e2e-before-turn");
  mkdirSync(root, { recursive: true });
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: join(root, "settings.json"),
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          usage: { input: 1000, output: 50, cacheRead: 5, cacheWrite: 950, totalTokens: 2000 },
        },
      },
      { model: { id: "m1" } },
    );
    await pi.emit("turn_end", { turnIndex: 0 }, {});
    let completed = false;
    const compactCtx = {
      getContextUsage: () => ({ percent: 85, tokens: 60_000 }),
      compact: (args: Record<string, unknown>) => {
        (args.onComplete as (() => void) | undefined)?.();
        completed = true;
      },
    };
    await pi.emit("input", { text: "hello", source: "interactive" }, compactCtx);
    assertEq(completed, true, "the prompt was deferred until compaction completed");
    // The warming observer is observational and must never throw; a landed
    // refresh in the session tail is reconciled alongside the decision.
    await pi.emit(
      "cache_warming_decision",
      { action: "warm" },
      {
        sessionManager: {
          getEntries: () => [
            { type: "message", id: "m1" },
            { type: "usage", id: "w1", kind: "cache_warm", timestamp: new Date().toISOString() },
          ],
        },
      },
    );
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: idle trigger fires at TTL expiry", async () => {
  const root = join(scratchDir(), "e2e-idle-ttl");
  mkdirSync(root, { recursive: true });
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: join(root, "settings.json"),
    PI_CACHE_FAST_COMPACT: "0",
    PI_CACHE_TTL_SECONDS: "1",
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    const compactCalls: Array<Record<string, unknown>> = [];
    const ctx = {
      getContextUsage: () => ({ percent: 85, tokens: 60_000 }),
      isIdle: () => true,
      sessionManager: { getSessionId: () => "sess1" },
      compact: (args: Record<string, unknown>) => {
        compactCalls.push(args);
        (args.onComplete as (() => void) | undefined)?.();
      },
    };
    // A warm cache is not compacted at settle without fast compaction.
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050 },
        },
      },
      { model: { id: "m1" } },
    );
    await pi.emit("turn_end", { turnIndex: 0 }, {});
    await pi.emit("agent_settled", {}, ctx);
    assertEq(compactCalls.length, 0, "warm settle does not compact");
    await waitFor(() => compactCalls.length >= 1, "idle TTL compaction fired", 2500);
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: warm-cache advisory is observational", async () => {
  const root = join(scratchDir(), "e2e-warm");
  mkdirSync(root, { recursive: true });
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: join(root, "settings.json"),
    PI_CACHE_ADVISORY: "1",
    PI_CACHE_FAST_COMPACT: "0",
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);

    // Warm usage: 90% cacheRead.
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 100, totalTokens: 1150 },
        },
      },
      { model: { id: "m1" } },
    );
    // A warm-cache compaction at a large size gets an advisory, and the
    // built-in proposal object is returned untouched (listener returns
    // nothing, so pi's own compaction proceeds).
    const results = await pi.emit(
      "session_before_compact",
      {
        preparation: { tokensBefore: 60_000, messagesToSummarize: ["a", "b"], firstKeptEntryId: "E1" },
        reason: "threshold",
      },
      {},
    );
    const advisory = pi.entries.find((e) => e.kind === "pi-cache-advisory");
    assert(advisory !== undefined, "advisory emitted for warm compaction");
    assertMatches(String((advisory.data as { message: string }).message), /warm cache/);
    assertEq(results[0], undefined, "listener returns nothing (observational)");
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: disabled features short-circuit", async () => {
  const root = join(scratchDir(), "e2e-off");
  mkdirSync(root, { recursive: true });
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: join(root, "settings.json"),
    PI_CACHE_AUTO_COMPACT: "0",
    PI_CACHE_PIN_SESSION: "0",
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    const { ctx, compactCalls } = makeCtx();
    await pi.emit("message_end", {
      message: {
        role: "assistant",
        usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 950, totalTokens: 2000 },
      },
    }, { model: { id: "m1" } });
    await pi.emit("turn_end", { turnIndex: 0 }, {});
    await pi.emit("agent_settled", {}, ctx);
    assertEq(compactCalls.length, 0, "auto-compact disabled never compacts");
    const headers: Record<string, string> = {};
    await pi.emit("before_provider_headers", { headers }, {});
    assertEq(headers["x-session-id"], undefined, "no header injection when disabled");
    let notified = "";
    const statsCtx = { ui: { notify: (text: string) => { notified = text; } } };
    await pi.commands.get("cache-stats")!.handler([], statsCtx as never);
    assert(notified.includes("compactions 0"), "no compactions recorded");
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: fast-compaction switch toggles and persists", async () => {
  const root = join(scratchDir(), "e2e-switch");
  mkdirSync(root, { recursive: true });
  const settingsFile = join(root, "settings.json");
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: settingsFile,
    PI_CACHE_AUTO_COMPACT: "0",
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    const ctx = {};

    const before = await pi.emit(
      "session_before_compact",
      { preparation: { firstKeptEntryId: "E1", tokensBefore: 10, messagesToSummarize: [] }, reason: "manual" },
      ctx,
    );
    assert(before[0] !== undefined, "fast compaction on by default");

    // Drive the two-column view: select the Fast compaction row and
    // confirm it, which must flip the switch off, persist, and notify.
    let view: { selectItem(id: string): void; handleInput(data: string): void } | undefined;
    let notified = "";
    const settingsCtx = {
      mode: "tui",
      ui: {
        custom: async (
          factory: (
            tui: unknown,
            theme: { fg: (c: string, t: string) => string },
            kb: unknown,
            done: () => void,
          ) => { selectItem(id: string): void; handleInput(data: string): void },
        ): Promise<void> => {
          view = factory({}, { fg: (_c, t) => t }, {}, () => {});
        },
        notify: (text: string) => {
          notified = text;
        },
      },
    };
    await pi.commands.get("cache-settings")!.handler([], settingsCtx as never);
    assert(view !== undefined, "switch row present");
    view.selectItem("fastCompaction");
    view.handleInput("\r");
    assert(notified.includes("fast compaction off"), "notification: " + notified);
    const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as { fastCompaction?: boolean };
    assertEq(saved.fastCompaction, false, "switch persisted off");

    const after = await pi.emit(
      "session_before_compact",
      { preparation: { firstKeptEntryId: "E2", tokensBefore: 10, messagesToSummarize: [] }, reason: "threshold" },
      ctx,
    );
    assertEq(after[0], undefined, "fast compaction off after toggle");
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: fast branch-summary switch toggles independently", async () => {
  const root = join(scratchDir(), "e2e-branch-switch");
  mkdirSync(root, { recursive: true });
  const settingsFile = join(root, "settings.json");
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: settingsFile,
    PI_CACHE_AUTO_COMPACT: "0",
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    const ctx = {};

    const treePrep = { preparation: { userWantsSummary: true, entriesToSummarize: [{}, {}] } };
    const before = await pi.emit("session_before_tree", treePrep, ctx);
    assert(before[0] !== undefined, "fast branch summary on by default");

    let view: { selectItem(id: string): void; handleInput(data: string): void } | undefined;
    const settingsCtx = {
      mode: "tui",
      ui: {
        custom: async (
          factory: (
            tui: unknown,
            theme: { fg: (c: string, t: string) => string },
            kb: unknown,
            done: () => void,
          ) => { selectItem(id: string): void; handleInput(data: string): void },
        ): Promise<void> => {
          view = factory({}, { fg: (_c, t) => t }, {}, () => {});
        },
        notify: () => {},
      },
    };
    await pi.commands.get("cache-settings")!.handler([], settingsCtx as never);
    assert(view !== undefined, "branch switch row present");
    view.selectItem("fastBranchSummary");
    view.handleInput("\r");
    const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as {
      fastBranchSummary?: boolean;
    };
    assertEq(saved.fastBranchSummary, false, "branch switch persisted off");

    const after = await pi.emit("session_before_tree", treePrep, ctx);
    assertEq(after[0], undefined, "branch summary off after toggle");
    const comp = await pi.emit(
      "session_before_compact",
      { preparation: { firstKeptEntryId: "E1", tokensBefore: 10, messagesToSummarize: [] }, reason: "manual" },
      ctx,
    );
    assert(comp[0] !== undefined, "compaction switch unaffected");
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: fast digest appends the span record and toggles independently", async () => {
  const root = join(scratchDir(), "e2e-digest-switch");
  mkdirSync(root, { recursive: true });
  const settingsFile = join(root, "settings.json");
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: settingsFile,
    PI_CACHE_AUTO_COMPACT: "0",
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    const ctx = {};

    // Default on: the fast proposal carries the digest after the stub.
    const prep = {
      preparation: {
        firstKeptEntryId: "E7",
        tokensBefore: 40_000,
        messagesToSummarize: [
          { role: "user", content: "repair the ledger" },
          { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
        ],
        fileOps: { read: new Set(["ledger.ts"]), edited: new Set() },
      },
      reason: "threshold",
    };
    const before = await pi.emit("session_before_compact", prep, ctx);
    const fast = before[0] as { compaction?: { summary: string } } | undefined;
    assert(fast?.compaction !== undefined, "fast override present");
    assert(fast!.compaction!.summary.startsWith(FAST_SUMMARY_STUB), "stub first");
    assert(fast!.compaction!.summary.includes("- U: repair the ledger"), "turn record");
    assert(fast!.compaction!.summary.includes("Files read: ledger.ts"), "file record");

    // Toggle it off through the two-column view: the stub stands alone.
    let view: { selectItem(id: string): void; handleInput(data: string): void } | undefined;
    const settingsCtx = {
      mode: "tui",
      ui: {
        custom: async (
          factory: (
            tui: unknown,
            theme: { fg: (c: string, t: string) => string },
            kb: unknown,
            done: () => void,
          ) => { selectItem(id: string): void; handleInput(data: string): void },
        ): Promise<void> => {
          view = factory({}, { fg: (_c, t) => t }, {}, () => {});
        },
        notify: () => {},
      },
    };
    await pi.commands.get("cache-settings")!.handler([], settingsCtx as never);
    assert(view !== undefined, "digest switch row present");
    view.selectItem("fastDigest");
    view.handleInput("\r");
    const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as {
      fastDigest?: boolean;
    };
    assertEq(saved.fastDigest, false, "digest switch persisted off");

    const after = await pi.emit("session_before_compact", prep, ctx);
    const fastAfter = after[0] as { compaction?: { summary: string } } | undefined;
    assert(fastAfter?.compaction !== undefined, "fast compaction unaffected");
    // This test's ctx carries no sessionManager, so no transcript pointer:
    // the legacy stub stands alone after the digest toggle.
    assertEq(fastAfter!.compaction!.summary, FAST_SUMMARY_STUB, "stub only after toggle");
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: option rows toggle, persist, and take effect", async () => {
  const root = join(scratchDir(), "e2e-option-switch");
  mkdirSync(root, { recursive: true });
  const settingsFile = join(root, "settings.json");
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: settingsFile,
    PI_CACHE_AUTO_COMPACT: "0",
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);

    // One recorded turn makes the ledger non-empty.
    const usageEvent = {
      message: {
        role: "assistant",
        usage: { input: 1000, output: 50, cacheRead: 5, cacheWrite: 950, totalTokens: 2000 },
      },
    };
    await pi.emit("message_end", usageEvent, { model: { id: "m1" } });
    let notified = "";
    const statsCtx = {
      getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
      ui: {
        notify: (text: string) => {
          notified = text;
        },
      },
    };
    await pi.commands.get("cache-stats")!.handler([], statsCtx as never);
    assert(notified.includes("global: 1 req"), "telemetry on records the turn: " + notified);

    // Toggle Telemetry off through the two-column view.
    let view: { selectItem(id: string): void; handleInput(data: string): void } | undefined;
    const settingsCtx = {
      mode: "tui",
      ui: {
        custom: async (
          factory: (
            tui: unknown,
            theme: { fg: (c: string, t: string) => string },
            kb: unknown,
            done: () => void,
          ) => { selectItem(id: string): void; handleInput(data: string): void },
        ): Promise<void> => {
          view = factory({}, { fg: (_c, t) => t }, {}, () => {});
        },
        notify: (text: string) => {
          notified = text;
        },
      },
    };
    await pi.commands.get("cache-settings")!.handler([], settingsCtx as never);
    assert(view !== undefined, "telemetry row present");
    view.selectItem("telemetry");
    view.handleInput("\r");
    assert(notified.includes("telemetry off"), "notification: " + notified);
    const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as { telemetry?: boolean };
    assertEq(saved.telemetry, false, "telemetry persisted off");

    // A second turn is dropped, so the ledger stays at one row.
    await pi.emit("message_end", usageEvent, { model: { id: "m1" } });
    await pi.commands.get("cache-stats")!.handler([], statsCtx as never);
    assert(notified.includes("global: 1 req"), "telemetry off drops the new turn: " + notified);
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});

test("extension: /cache-settings restore clears the stored overrides", async () => {
  const root = join(scratchDir(), "e2e-restore");
  mkdirSync(root, { recursive: true });
  const settingsFile = join(root, "settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({ telemetry: false, anchor: false }) + "\n",
    { mode: 0o600 },
  );
  setEnv({
    PI_CACHE_LEDGER: join(root, "ledger.jsonl"),
    PI_CACHE_SETTINGS: settingsFile,
  });
  try {
    const { default: factory } = await import("../src/index.ts");
    const pi = new MockPi();
    factory(pi as never);
    let notified = "";
    const notifyCtx = {
      mode: "print",
      ui: { notify: (text: string) => { notified = text; } },
    };
    await pi.commands.get("cache-settings")!.handler("restore", notifyCtx as never);
    assert(notified.includes("restored default configuration"), "notify: " + notified);
    assertEq(readFileSync(settingsFile, "utf8").trim(), "{}", "overrides cleared");

    // The `reset` alias behaves the same.
    await pi.commands.get("cache-settings")!.handler("reset", notifyCtx as never);
    assert(notified.includes("restored default configuration"), "alias: " + notified);

    // The stderr fallback listing still names the action row.
    let printed = "";
    const original = console.error;
    console.error = (line?: unknown) => {
      printed += String(line);
    };
    try {
      await pi.commands.get("cache-settings")!.handler("", { mode: "print" } as never);
    } finally {
      console.error = original;
    }
    assert(printed.includes("Restore default configuration"), "fallback lists the row");
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});
