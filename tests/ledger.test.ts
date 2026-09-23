/**
 * pi-cache — ledger + sink tests.
 * CacheLedger must own rows and totals, and the FileRecordSink must
 * persist JSONL rehydratable across process instances with dedup by the
 * globally-unique row id.
 */

import { test, assert, assertEq, assertDeepEq, scratchDir, waitFor } from "./harness.ts";
import { CacheLedger } from "../src/ledger.ts";
import { FileRecordSink } from "../src/sink.ts";
import type { RecordSink, UsageRow } from "../src/ledger.ts";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

/** In-memory sink for pure ledger behavior tests. */
class MemorySink implements RecordSink {
  rows: UsageRow[] = [];
  append(row: UsageRow): void {
    this.rows.push(row);
  }
  load(): UsageRow[] {
    return [...this.rows];
  }
  transform(keep: (rows: UsageRow[]) => UsageRow[]): void {
    const raw = [...this.rows];
    const next = keep(raw);
    if (next !== raw) this.rows = next.map((row) => ({ ...row }));
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

const usage = {
  input: 1000,
  output: 200,
  cacheRead: 750,
  cacheWrite: 250,
  totalTokens: 2200,
};

test("ledger: records rows with unique monotonic ids", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  ledger.record(usage, "model-x", "s1");
  ledger.record(usage, "model-x", "s1");
  assertEq(sink.rows.length, 2);
  assert(sink.rows[0].id !== sink.rows[1].id, "row ids differ");
  assert(sink.rows[1].seq > sink.rows[0].seq, "seq monotonic");
  assertEq(sink.rows[0].session, "s1");
  assertEq(sink.rows[0].model, "model-x");
  assertEq(sink.rows[0].cacheRead, 750);
  assert(sink.rows[0].pid === process.pid, "pid recorded");
});

test("ledger: ignores undefined usage and disabled ledger", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, false);
  ledger.record(undefined, "m");
  ledger.record(usage, "m", "s");
  assertEq(sink.rows.length, 0, "disabled records nothing");

  const sink2 = new MemorySink();
  const ledger2 = new CacheLedger(sink2, true);
  ledger2.record(undefined, "m");
  assertEq(sink2.rows.length, 0, "undefined usage records nothing");
});

test("ledger: totals, session totals, last usage, gap", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  assertEq(ledger.totals().n, 0);
  assertEq(ledger.sessionTotals().n, 0);
  assertEq(ledger.lastUsage(), undefined);
  assertEq(ledger.msSinceLastTurn(), Number.POSITIVE_INFINITY);

  ledger.record({ ...usage, input: 100, cacheRead: 900 }, "m", "s");
  const totals = ledger.totals();
  assertEq(totals.n, 1);
  assertEq(totals.input, 100);
  assertEq(totals.cacheRead, 900);
  const session = ledger.sessionTotals();
  assertEq(session.n, 1, "session totals count this process's rows");
  assertEq(session.cacheRead, 900);
  assertDeepEq(
    { ...ledger.lastUsage() },
    { input: 100, cacheRead: 900, cacheWrite: 250 },
  );
  assert(ledger.msSinceLastTurn() < 5000, "gap is recent");
});

test("ledger: rehydrates rows and dedups by row id", async () => {
  const file = join(scratchDir(), "ledger-rehydrate.jsonl");
  const sinkA = new FileRecordSink(file);
  const a = new CacheLedger(sinkA, true);
  a.record(usage, "m", "s");
  a.record(usage, "m", "s");
  await waitFor(() => {
    try {
      return readFileSync(file, "utf8").split("\n").filter(Boolean).length === 2;
    } catch {
      return false;
    }
  }, "rows persisted");

  // Second "process": a fresh ledger over the same file. Rehydrated rows
  // are global only; the new process's session starts empty.
  const b = new CacheLedger(new FileRecordSink(file), true);
  assertEq(b.totals().n, 2, "rehydrated cumulative totals");
  assertEq(b.sessionTotals().n, 0, "rehydrated rows are not session rows");
  b.record(usage, "m", "s");
  assertEq(b.totals().n, 3);
  assertEq(b.sessionTotals().n, 1, "only this process's row is session");
  await waitFor(() => {
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    return rows === 3;
  }, "appended row persisted");
});

test("ledger: torn/corrupt ledger lines are skipped", () => {
  const file = join(scratchDir(), "ledger-corrupt.jsonl");
  writeFileSync(
    file,
    '{"id":"a:1:0","seq":0,"ts":1,"pid":1,"session":"s","model":"m","input":1,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":1}\nNOT-JSON\n{"broken": true}\n',
    "utf8",
  );
  const ledger = new CacheLedger(new FileRecordSink(file), true);
  assertEq(ledger.totals().n, 1, "only the valid line loads");
});

test("ledger: retention bounds the file and rewrites on load", () => {
  const sink = new MemorySink();
  const now = Date.now();
  sink.rows = [0, 1, 2, 3, 4].map((i) => ({
    id: `r${i}`,
    seq: i,
    ts: now + i,
    pid: 1,
    session: "s",
    model: "m",
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1,
  }));
  const ledger = new CacheLedger(sink, true, 2);
  assertEq(ledger.totals().n, 2, "only the newest rows retained");
  assertEq(sink.rows.length, 2, "file rewritten to the retained window");
  assertDeepEq(sink.rows.map((r) => r.id), ["r3", "r4"]);
});

test("ledger: retention bounds the file during a long session", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true, 2);
  for (let i = 0; i < 6; i++) ledger.record(usage, "m", "s");
  assertEq(sink.rows.length, 2, "file bounded without waiting for close");
  assertEq(ledger.totals().n, 2, "in-memory window retained");
});

test("ledger: compact rewrites only when rows were dropped", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true, 2);
  ledger.record(usage, "m", "s");
  ledger.record(usage, "m", "s");
  assertEq(ledger.compact(), false, "within the window: no rewrite");
  ledger.record(usage, "m", "s");
  assertEq(ledger.compact(), true, "over the window: rewrite");
  assertEq(ledger.totals().n, 2);
  assertEq(sink.rows.length, 2);
});

test("ledger: flush resolves through the sink", async () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  await ledger.flush();
  assert(true, "flush resolved");
});

test("ledger: useSession rebuilds the session window from persisted rows", () => {
  const sink = new MemorySink();
  const now = Date.now();
  sink.rows = [
    { id: "a", seq: 0, ts: now, pid: 1, session: "s1", model: "m", input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    { id: "b", seq: 1, ts: now + 1, pid: 1, session: "s2", model: "m", input: 2, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    { id: "c", seq: 2, ts: now + 2, pid: 1, session: "s1", model: "m", input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
  ];
  const ledger = new CacheLedger(sink, true);
  assertEq(ledger.sessionTotals().n, 0, "no session adopted yet");
  ledger.useSession("s1");
  assertEq(ledger.sessionTotals().n, 2, "session rows rebuilt");
  assertEq(ledger.lastUsage()?.input, 3, "newest session row");
});

test("ledger: close flushes and bounds the file", async () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true, 2);
  ledger.record(usage, "m", "s");
  ledger.record(usage, "m", "s");
  ledger.record(usage, "m", "s");
  await ledger.close();
  assertEq(sink.rows.length, 2, "file bounded after close");
});

test("ledger: record with extras carries the cache-state fields", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  ledger.record(usage, "m", "s", {
    cacheTtlMs: 300_000,
    piTtlMs: 300_000,
    retentionLong: false,
    warm: true,
    msSinceCacheTouch: 42_000,
  });
  assertEq(sink.rows.length, 1);
  assertEq(sink.rows[0].cacheTtlMs, 300_000);
  assertEq(sink.rows[0].piTtlMs, 300_000);
  assertEq(sink.rows[0].retentionLong, false);
  assertEq(sink.rows[0].warm, true);
  assertEq(sink.rows[0].msSinceCacheTouch, 42_000);
});

test("ledger: record without extras keeps the old schema", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  ledger.record(usage, "m", "s");
  const row = sink.rows[0];
  assertEq(row.cacheTtlMs, undefined, "no cacheTtlMs");
  assertEq(row.piTtlMs, undefined, "no piTtlMs");
  assertEq(row.retentionLong, undefined, "no retentionLong");
  assertEq(row.warm, undefined, "no warm");
  assertEq(row.msSinceCacheTouch, undefined, "no msSinceCacheTouch");
});

test("ledger: old-schema rows rehydrate alongside extended rows", async () => {
  const file = join(scratchDir(), "ledger-mixed-schema.jsonl");
  const oldRow = {
    id: "old:1",
    seq: 0,
    ts: Date.now() - 1000,
    pid: 1,
    session: "s",
    model: "m",
    input: 10,
    output: 0,
    cacheRead: 5,
    cacheWrite: 0,
    totalTokens: 15,
  };
  writeFileSync(file, JSON.stringify(oldRow) + "\n");
  const ledger = new CacheLedger(new FileRecordSink(file), true);
  assertEq(ledger.totals().n, 1, "old row rehydrates");
  ledger.record(usage, "m", "s", { cacheTtlMs: 300_000, warm: false });
  await waitFor(() => {
    try {
      return readFileSync(file, "utf8").split("\n").filter(Boolean).length === 2;
    } catch {
      return false;
    }
  }, "extended row persisted");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const parsed = lines.map((l) => JSON.parse(l) as UsageRow);
  assertEq(parsed[0].cacheTtlMs, undefined, "old row untouched");
  assertEq(parsed[1].cacheTtlMs, 300_000, "new row carries extras");
});

test("ledger: warm rows are recorded but never masquerade as turns", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  ledger.useSession("s");
  ledger.record({ ...usage, input: 100, cacheRead: 900 }, "m");
  const turnGap = ledger.msSinceLastTurn();
  ledger.recordWarm({ input: 5000, output: 1, cacheRead: 50_000, cacheWrite: 0, totalTokens: 55_001 }, "m");
  assertEq(sink.rows.length, 2, "warm row recorded");
  assertEq(sink.rows[1].warm, true, "flagged warm");
  assertEq(ledger.totals().n, 2, "totals count warm rows");
  assertEq(ledger.sessionTotals().n, 2, "session totals count warm rows");
  assert(ledger.msSinceLastTurn() >= turnGap, "warm rows do not reset the turn clock");
  assertEq(ledger.lastUsage()?.input, 100, "lastUsage is the real turn");
  assertEq(ledger.lastRowId(), sink.rows[0].id, "window key skips warm rows");
});

test("ledger: recordWarm of nothing records nothing", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, false);
  ledger.recordWarm(undefined, "m");
  ledger.recordWarm({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 }, "m");
  assertEq(sink.rows.length, 0, "disabled or empty usage records nothing");
});
