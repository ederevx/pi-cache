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
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { FAST_SUMMARY_STUB } from "../src/fastcompact.ts";

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
  "PI_CACHE_SORT_TOOLS",
  "PI_CACHE_DEDUP_TOOLS",
  "PI_CACHE_PIN_SESSION",
  "PI_CACHE_ADVISORY",
  "PI_CACHE_AUTO_COMPACT",
  "PI_CACHE_FAST_COMPACT",
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
      tools: [{ name: "z", description: "z" }, { name: "a", description: "a" }, { name: "z", description: "z" }],
    };
    const [normalizedA] = await pi.emit("before_provider_request", { payload: payloadA }, {});
    assertEq(normalizedA, payloadA, "same object reference returned");
    assertToolNames((normalizedA as { tools: Array<{ name: string }> }).tools, ["a", "z"]);

    // Session pin: no provider session header -> stable id injected.
    const headers: Record<string, string> = {};
    await pi.emit("before_provider_headers", { headers }, {});
    assertMatches(headers["x-session-id"] ?? "", /^pi-cache-[0-9a-f]{24}$/);

    await pi.emit("before_provider_request", { payload: { ...payloadA, model: "model-b" } }, {});

    // 3. turn_end + agent_settled: cold + churned + context 85% -> compact.
    const { ctx, compactCalls } = makeCtx();
    await pi.emit("turn_end", { turnIndex: 0 }, {});
    await pi.emit("agent_settled", {}, ctx);
    assertEq(compactCalls.length, 1, "cold+churned window compacts");
    const call = compactCalls[0];
    assert(typeof call.onComplete === "function", "onComplete callback bound");
    assert(typeof call.onError === "function", "onError callback bound");
    (call.onComplete as () => void)();

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
    const fast = compactResults[1] as { compaction?: { summary: string; firstKeptEntryId: string } } | undefined;
    assert(fast?.compaction !== undefined, "fast override returned a compaction");
    assertEq(fast!.compaction!.summary, FAST_SUMMARY_STUB);
    assertEq(fast!.compaction!.firstKeptEntryId, "E9");

    // 5. /cache-stats reflects ledger + churn + affinity + compactions.
    let notified = "";
    const statsCtx = { ui: { notify: (text: string) => { notified = text; } } };
    await pi.commands.get("cache-stats")!.handler([], statsCtx as never);
    assert(notified.includes("pi-cache: 1 req"), "stats counts requests: " + notified);
    assert(notified.includes("head churn 1"), "stats reports churn: " + notified);
    assert(notified.includes("compactions 1"), "stats reports compact count: " + notified);

    // 6. /cache-settings lists the current option rows.
    let selectTitle = "";
    let selectOptions: string[] = [];
    const settingsCtx = {
      ui: {
        select: (title: string, options: string[]) => {
          selectTitle = title;
          selectOptions = options;
          return Promise.resolve("x");
        },
      },
      mode: "tui",
    };
    await pi.commands.get("cache-settings")!.handler([], settingsCtx as never);
    assertEq(selectTitle, "pi-cache settings");
    assertEq(selectOptions.length, 7, "one settings row per option");

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
    assertEq(headers["x-session-id"], undefined, "pinning disabled injects nothing");
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
    assert(before[1] !== undefined, "fast compaction on by default");

    // Select the Fast compaction row: it must flip off and persist.
    let options: string[] = [];
    const settingsCtx = {
      mode: "tui",
      ui: {
        select: (_t: string, o: string[]) => {
          options = o;
          return Promise.resolve(o.find((line) => line.startsWith("Fast compaction:"))!);
        },
        notify: () => {},
      },
    };
    await pi.commands.get("cache-settings")!.handler([], settingsCtx as never);
    assert(options.some((line) => line.startsWith("Fast compaction:")), "switch row present");
    const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as { fastCompaction?: boolean };
    assertEq(saved.fastCompaction, false, "switch persisted off");

    const after = await pi.emit(
      "session_before_compact",
      { preparation: { firstKeptEntryId: "E2", tokensBefore: 10, messagesToSummarize: [] }, reason: "threshold" },
      ctx,
    );
    assertEq(after[1], undefined, "fast compaction off after toggle");
  } finally {
    unsetEnv(PI_CACHE_KEYS);
  }
});
