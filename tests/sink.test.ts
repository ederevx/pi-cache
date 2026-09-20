/**
 * pi-cache — file ledger sink tests.
 * The sink owns the bytes: appends serialize behind flush, rewrite is
 * atomic with no leftover temp, and it preserves the ledger's mode.
 */

import { test, assertEq, scratchDir } from "./harness.ts";
import { FileRecordSink } from "../src/sink.ts";
import { BackupStore } from "../src/backup-store.ts";
import { readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageRow } from "../src/ledger.ts";

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
  sink.append(row(1));
  sink.append(row(2));
  await sink.flush();
  assertEq(sink.load().length, 2);
});

test("sink: rewrite is atomic and leaves no temp file", () => {
  const dir = join(scratchDir(), "sink-rewrite");
  const file = join(dir, "ledger.jsonl");
  const sink = new FileRecordSink(file);
  sink.rewrite([row(1)]);
  assertEq(sink.load().length, 1);
  assertEq(readdirSync(dir).filter((name) => name.includes(".tmp")).length, 0, "no temp left");
});

test("sink: rewrite preserves the ledger mode", () => {
  const dir = join(scratchDir(), "sink-mode");
  const file = join(dir, "ledger.jsonl");
  const sink = new FileRecordSink(file);
  sink.rewrite([row(1)]);
  const first = statSync(file).mode & 0o777;
  sink.rewrite([row(1), row(2)]);
  assertEq(statSync(file).mode & 0o777, first, "mode preserved");
});

test("sink: append never drops a row under lock contention", () => {
  const dir = join(scratchDir(), "sink-lock");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ledger.jsonl");
  writeFileSync(`${file}.lock`, "held", { mode: 0o600 });
  const sink = new FileRecordSink(file);
  sink.append(row(1));
  assertEq(sink.load().length, 1, "row persisted despite lock contention");
});

test("sink: a shrinking rewrite captures a bounded backup", () => {
  const dir = join(scratchDir(), "sink-backup");
  const file = join(dir, "ledger.jsonl");
  const backups = new BackupStore(join(dir, "backups"), { keep: 3, ttlMs: 0, maxBytes: 0 });
  const sink = new FileRecordSink(file, backups);
  sink.rewrite([row(1), row(2), row(3)]);
  assertEq(backupCount(join(dir, "backups")), 0, "growth writes do not back up");
  sink.rewrite([row(1)]);
  assertEq(backupCount(join(dir, "backups")), 1, "shrinking rewrite captures the pre-image");
  assertEq(sink.load().length, 1);
});
