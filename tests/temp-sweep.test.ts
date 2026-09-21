/**
 * pi-cache — stale temp-file sweeper tests.
 * The sweeper must remove only abandoned temp files (past the staleness
 * grace), leave a fresh in-flight temp alone, and no-op on a missing dir.
 */

import { test, assertEq, scratchDir } from "./harness.ts";
import { TempSweeper } from "../src/temp-sweep.ts";
import { mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";

const past = new Date(Date.now() - 2 * 60 * 60 * 1000);

test("temp-sweep: removes only abandoned temp files", () => {
  const dir = join(scratchDir(), "sweep");
  mkdirSync(dir, { recursive: true });
  const keep = join(dir, "ledger.jsonl");
  const oldTmp = join(dir, "ledger.jsonl.123.tmp");
  const manifestTmp = join(dir, "manifest.json.tmp");
  writeFileSync(keep, "x");
  writeFileSync(oldTmp, "x");
  writeFileSync(manifestTmp, "x");
  utimesSync(oldTmp, past, past);
  utimesSync(manifestTmp, past, past);
  assertEq(new TempSweeper().sweep(dir), 2);
  assertEq(existsSync(keep), true, "real file kept");
  assertEq(existsSync(oldTmp), false);
  assertEq(existsSync(manifestTmp), false);
});

test("temp-sweep: a .tmp substring in a non-temp name is kept", () => {
  const dir = join(scratchDir(), "sweep-substring");
  mkdirSync(dir, { recursive: true });
  const keep = join(dir, "notes.tmp.bak");
  const keep2 = join(dir, "data.tmpdir");
  writeFileSync(keep, "x");
  writeFileSync(keep2, "x");
  utimesSync(keep, past, past);
  utimesSync(keep2, past, past);
  assertEq(new TempSweeper().sweep(dir), 0);
  assertEq(existsSync(keep), true, "a .tmp substring is not a temp");
  assertEq(existsSync(keep2), true, "a .tmp prefix is not a temp");
});

test("temp-sweep: a fresh temp file is left for its writer", () => {
  const dir = join(scratchDir(), "sweep-fresh");
  mkdirSync(dir, { recursive: true });
  const fresh = join(dir, "ledger.jsonl.9.tmp");
  writeFileSync(fresh, "x");
  assertEq(new TempSweeper().sweep(dir), 0);
  assertEq(existsSync(fresh), true);
});

test("temp-sweep: a missing directory is a no-op", () => {
  assertEq(new TempSweeper().sweep(join(scratchDir(), "does-not-exist")), 0);
});
