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

test("ledger: totals, cache ratio, last usage, gap", () => {
  const sink = new MemorySink();
  const ledger = new CacheLedger(sink, true);
  assertEq(ledger.cacheRatio(), 0);
  assertEq(ledger.lastUsage(), undefined);
  assertEq(ledger.msSinceLastTurn(), Number.POSITIVE_INFINITY);

  ledger.record({ ...usage, input: 100, cacheRead: 900 }, "m", "s");
  const totals = ledger.totals();
  assertEq(totals.n, 1);
  assertEq(totals.input, 100);
  assertEq(totals.cacheRead, 900);
  assert(Math.abs(ledger.cacheRatio() - 0.9) < 1e-9, "cache ratio 0.9");
  assertDeepEq(
    { ...ledger.lastUsage() },
    { input: 100, cacheRead: 900, cacheWrite: 250 },
  );
  assert(ledger.msSinceLastTurn() < 5000, "gap is recent");
  assert(ledger.summary().includes("1 req"), "summary counts requests");
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

  // Second "process": a fresh ledger over the same file.
  const b = new CacheLedger(new FileRecordSink(file), true);
  assertEq(b.totals().n, 2, "rehydrated cumulative totals");
  b.record(usage, "m", "s");
  assertEq(b.totals().n, 3);
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

test("ledger: session signal stubs are inert", () => {
  // The AutocompactSignal defaults on the ledger are intentional no-ops;
  // the wiring feeds real churn/rotation signals instead.
  const ledger = new CacheLedger(new MemorySink(), true);
  assertEq(ledger.headChurn(), 0);
  assertEq(ledger.affinityRotated(), false);
});