/**
 * pi-cache — stale temp-file sweeper tests.
 * The sweeper must remove only atomic-write temp files and must be a no-op
 * on a missing directory.
 */

import { test, assertEq, scratchDir } from "./harness.ts";
import { TempSweeper } from "../src/temp-sweep.ts";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("temp-sweep: removes only temp files", () => {
  const dir = join(scratchDir(), "sweep");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ledger.jsonl"), "x");
  writeFileSync(join(dir, "ledger.jsonl.123.tmp"), "x");
  writeFileSync(join(dir, "manifest.json.tmp"), "x");
  const removed = new TempSweeper().sweep(dir);
  assertEq(removed, 2);
  assertEq(existsSync(join(dir, "ledger.jsonl")), true, "real file kept");
  assertEq(existsSync(join(dir, "ledger.jsonl.123.tmp")), false);
  assertEq(existsSync(join(dir, "manifest.json.tmp")), false);
});

test("temp-sweep: a missing directory is a no-op", () => {
  assertEq(new TempSweeper().sweep(join(scratchDir(), "does-not-exist")), 0);
});