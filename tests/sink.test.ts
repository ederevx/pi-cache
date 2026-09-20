/**
 * pi-cache — file ledger sink tests.
 * The sink owns the bytes: appends serialize behind flush, rewrite is
 * atomic with no leftover temp, and it preserves the ledger's mode.
 */

import { test, assertEq, scratchDir } from "./harness.ts";
import { FileRecordSink } from "../src/sink.ts";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UsageRow } from "../src/ledger.ts";

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
