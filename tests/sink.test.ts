/**
 * pi-cache — file ledger sink tests.
 * The sink owns the bytes: appends serialize behind flush, rewrite is
 * atomic with no leftover temp, and it preserves the ledger's mode.
 */

import { test, assertEq, assert, scratchDir } from "./harness.ts";
import { FileRecordSink } from "../src/sink.ts";
import { BackupStore } from "../src/backup-store.ts";
import { readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerSnapshot, UsageRow, UsageTotals } from "../src/ledger.ts";

function zero(): UsageTotals {
  return { input: 0, cacheRead: 0, cacheWrite: 0, n: 0 };
}

function snapshot(rows: UsageRow[], baseline?: UsageTotals): LedgerSnapshot {
  return { baseline: baseline ?? zero(), rows };
}

/** Count retained backups without exposing a test-only method. */
function backupCount(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

function row(i: number): UsageRow {
  return {
    id: `r${i}`,
    seq: i,
    ts: i,
    pid: 1,
    session: "s",
    model: "m",
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1,
  };
}

test("sink: append/flush/load round-trip", async () => {
  const file = join(scratchDir(), "sink-roundtrip.jsonl");
  const sink = new FileRecordSink(file);
  assertEq(sink.append(row(1)), true, "first append commits");
  assertEq(sink.append(row(2)), true, "second append commits");
  await sink.flush();
  assertEq(sink.load().rows.length, 2);
});

test("sink: rewrite is atomic and leaves no temp file", () => {
  const dir = join(scratchDir(), "sink-rewrite");
  const file = join(dir, "ledger.jsonl");
  const sink = new FileRecordSink(file);
  sink.rewrite(snapshot([row(1)]));
  assertEq(sink.load().rows.length, 1);
  assertEq(readdirSync(dir).filter((name) => name.includes(".tmp")).length, 0, "no temp left");
});

test("sink: rewrite preserves the ledger mode", () => {
  const dir = join(scratchDir(), "sink-mode");
  const file = join(dir, "ledger.jsonl");
  const sink = new FileRecordSink(file);
  sink.rewrite(snapshot([row(1)]));
  const first = statSync(file).mode & 0o777;
  sink.rewrite(snapshot([row(1), row(2)]));
  assertEq(statSync(file).mode & 0o777, first, "mode preserved");
});

test("sink: append fails closed under lock contention, never unlocked", () => {
  const dir = join(scratchDir(), "sink-lock");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ledger.jsonl");
  writeFileSync(`${file}.lock`, "held", { mode: 0o600 });
  const sink = new FileRecordSink(file);
  assertEq(sink.append(row(1)), false, "contended append reports failure");
  assertEq(sink.load().rows.length, 0, "no row written outside the lock");
});

test("sink: baseline header round-trips and is never a usage row", () => {
  const file = join(scratchDir(), "sink-baseline.jsonl");
  const sink = new FileRecordSink(file);
  sink.rewrite(snapshot([row(1)], { input: 100, cacheRead: 50, cacheWrite: 5, n: 7 }));
  const loaded = sink.load();
  assertEq(loaded.baseline.n, 7, "baseline count rehydrates");
  assertEq(loaded.baseline.input, 100, "baseline input rehydrates");
  assertEq(loaded.rows.length, 1, "only usage rows load as rows");
  assert(statSync(file).size > 0, "file written");
});

test("sink: a shrinking rewrite captures a bounded backup", () => {
  const dir = join(scratchDir(), "sink-backup");
  const file = join(dir, "ledger.jsonl");
  const backups = new BackupStore(join(dir, "backups"), { keep: 3, ttlMs: 0, maxBytes: 0 });
  const sink = new FileRecordSink(file, backups);
  sink.rewrite(snapshot([row(1), row(2), row(3)]));
  assertEq(backupCount(join(dir, "backups")), 0, "growth writes do not back up");
  sink.rewrite(snapshot([row(1)]));
  assertEq(backupCount(join(dir, "backups")), 1, "shrinking rewrite captures the pre-image");
  assertEq(sink.load().rows.length, 1);
});
