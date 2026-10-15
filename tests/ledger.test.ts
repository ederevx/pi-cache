/**
 * pi-cache — ledger + sink tests.
 * CacheLedger must own rows and totals, and the FileRecordSink must
 * persist JSONL rehydratable across process instances with dedup by the
 * globally-unique row id.
 */

import { test, assert, assertEq, assertDeepEq, scratchDir, waitFor } from "./harness.ts";
import { CacheLedger } from "../src/ledger.ts";
import { FileRecordSink } from "../src/sink.ts";
import type {
  LedgerSnapshot,
  RecordSink,
  SinkCommit,
  UsageRow,
  UsageTotals,
} from "../src/ledger.ts";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

/** In-memory sink for pure ledger behavior tests. */
class MemorySink implements RecordSink {
  baseline: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, n: 0 };
  rows: UsageRow[] = [];
  append(row: UsageRow): boolean {
    this.rows.push(row);
    return true;
  }
  load(): LedgerSnapshot {
    return { baseline: { ...this.baseline }, rows: [...this.rows] };
  }
  transform(keep: (snapshot: LedgerSnapshot) => LedgerSnapshot): SinkCommit {
    const raw = this.load();
    const next = keep(raw);
    if (next === raw) return { snapshot: raw, rewritten: false };
    this.baseline = { ...next.baseline };
    this.rows = next.rows.map((row) => ({ ...row }));
    return { snapshot: { baseline: { ...this.baseline }, rows: [...this.rows] }, rewritten: true };
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

test("ledger: retention bounds the file but keeps lifetime totals", () => {
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
  assertEq(ledger.totals().n, 5, "lifetime counts every recorded row");
  assertEq(ledger.retainedTotals().n, 2, "retained window is bounded");
  assertEq(sink.rows.length, 2, "file rewritten to the retained window");
  assertDeepEq(sink.rows.map((r) => r.id), ["r3", "r4"]);
  assertEq(sink.baseline.n, 3, "evicted rows folded into the baseline");
});

test("ledger: retention bounds the file during a long session", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true, 2);
  for (let i = 0; i < 6; i++) ledger.record(usage, "m", "s");
  assertEq(sink.rows.length, 2, "file bounded without waiting for close");
  assertEq(ledger.retainedTotals().n, 2, "in-memory window retained");
  assertEq(ledger.sessionTotals().n, 2, "session window stays bounded");
  assertEq(sink.baseline.n, 4, "evicted rows counted once in the baseline");
  assertEq(ledger.totals().n, 6, "lifetime reaches past the window");
  assertEq(ledger.totals().input, 6000, "lifetime token sums are complete");
});

test("ledger: compact rewrites only when rows were dropped", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true, 2);
  ledger.record(usage, "m", "s");
  ledger.record(usage, "m", "s");
  assertEq(ledger.compact(), false, "within the window: no rewrite");
  ledger.record(usage, "m", "s");
  assertEq(ledger.compact(), true, "over the window: rewrite");
  assertEq(ledger.totals().n, 3, "lifetime is not capped by the window");
  assertEq(sink.rows.length, 2);
  assertEq(sink.baseline.n, 1);
});

test("ledger: flush resolves through the sink", async () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  await ledger.flush();
  assert(true, "flush resolved");
});

test("ledger: lifetime totals survive reload from the baseline", () => {
  const sink = new MemorySink();
  const first = new CacheLedger(sink, true, 2);
  for (let i = 0; i < 5; i++) first.record(usage, "m", "s");
  const second = new CacheLedger(sink, true, 2);
  assertEq(second.totals().n, 5, "baseline + window rehydrate the lifetime");
  assertEq(second.retainedTotals().n, 2, "window still bounded");
  assertEq(second.sessionTotals().n, 0, "a reload has no session yet");
});

test("ledger: two writers share the lifetime without double counting", () => {
  const file = join(scratchDir(), "ledger-two-writers.jsonl");
  const a = new CacheLedger(new FileRecordSink(file), true, 2);
  const b = new CacheLedger(new FileRecordSink(file), true, 2);
  for (let i = 0; i < 3; i++) a.record(usage, "m", "s");
  for (let i = 0; i < 3; i++) b.record(usage, "m", "s");
  const reloaded = new CacheLedger(new FileRecordSink(file), true, 2);
  assertEq(reloaded.totals().n, 6, "both writers' rows counted once");
  assertEq(reloaded.retainedTotals().n, 2, "the shared window stays bounded");
});

test("ledger: an unpersisted row is not counted", () => {
  const sink = new MemorySink();
  sink.append = () => false;
  const ledger = new CacheLedger(sink, true, 2);
  const row = ledger.record(usage, "m", "s");
  assertEq(row, undefined, "failed persistence reports no row");
  assertEq(ledger.totals().n, 0, "a failed append never inflates totals");
  assertEq(ledger.sessionTotals().n, 0, "session totals stay tied to disk");
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
  assertEq(ledger.totals().n, 3, "close never drops a lifetime count");
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

test("ledger: cache-warm turn rows still advance the compaction window", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  ledger.useSession("s");
  // A cold turn, then ordinary turns recorded while the cache was warm (the
  // normal active-session case). The telemetry `warm` flag must never hide a
  // real turn from the turn-scoped accessors, or the gate window pins.
  ledger.record({ ...usage, input: 10 }, "m", "s", { cacheTtlMs: 300_000, warm: false });
  ledger.record({ ...usage, input: 20 }, "m", "s", { cacheTtlMs: 300_000, warm: true });
  ledger.record({ ...usage, input: 30 }, "m", "s", { cacheTtlMs: 300_000, warm: true });
  assertEq(ledger.lastUsage()?.input, 30, "newest warm-cache turn is the turn view");
  assertEq(ledger.lastRowId(), sink.rows[2].id, "window key follows warm-cache turns");
  assertEq(sink.rows[2].kind, "turn", "turn rows are kind turn");
  ledger.recordWarm({ input: 1, output: 0, cacheRead: 1, cacheWrite: 0, totalTokens: 2 }, "m");
  assertEq(sink.rows[3].kind, "warm", "refresh rows are kind warm");
  assertEq(ledger.lastRowId(), sink.rows[2].id, "refresh rows never move the window key");
  assertEq(ledger.lastUsage()?.input, 30, "refresh rows never move the turn view");
});

test("ledger: recordWarm of nothing records nothing", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, false);
  ledger.recordWarm(undefined, "m");
  ledger.recordWarm({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 }, "m");
  assertEq(sink.rows.length, 0, "disabled or empty usage records nothing");
});

test("ledger: lastRequestUsage sees warm rows lastUsage skips", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  ledger.useSession("s");
  ledger.record({ ...usage, input: 100, cacheRead: 900 }, "m");
  ledger.recordWarm({ input: 5000, output: 1, cacheRead: 50_000, cacheWrite: 0, totalTokens: 55_001 }, "m");
  assertEq(ledger.lastUsage()?.input, 100, "turn-scoped view skips the warm row");
  assertEq(ledger.lastRequestUsage()?.input, 5000, "request view reads the warm row");
  assertEq(ledger.lastRequestUsage()?.cacheRead, 50_000, "warm refresh carries its usage");
});
