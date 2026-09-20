/**
 * pi-cache — ledger backup store tests.
 * Captures must copy the source, and the store must stay bounded by ring,
 * TTL, and total size.
 */

import { test, assertEq, scratchDir } from "./harness.ts";
import { BackupStore } from "../src/backup-store.ts";
import { mkdirSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";

const baseOpts = { keep: 3, ttlMs: 0, maxBytes: 0 };

test("backup-store: capture copies the source and ring-prunes", () => {
  const root = scratchDir();
  const dir = join(root, "backups-ring");
  const src = join(root, "ledger-ring.jsonl");
  writeFileSync(src, "row-a\n");
  const store = new BackupStore(dir, { ...baseOpts, keep: 2 });
  for (let i = 0; i < 5; i++) store.capture(src);
  assertEq(store.count(), 2, "ring keeps only the newest");
  assertEq(readdirSync(dir).length, 2);
});

test("backup-store: prune drops backups past the TTL", () => {
  const root = scratchDir();
  const dir = join(root, "backups-ttl");
  const src = join(root, "ledger-ttl.jsonl");
  writeFileSync(src, "row-a\n");
  const store = new BackupStore(dir, { keep: 10, ttlMs: 60_000, maxBytes: 0 });
  store.capture(src);
  const old = new Date(Date.now() - 120_000);
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), old, old);
  store.prune();
  assertEq(store.count(), 0, "expired backup pruned");
});

test("backup-store: prune honors the total size cap", () => {
  const root = scratchDir();
  const dir = join(root, "backups-size");
  const src = join(root, "ledger-size.jsonl");
  const store = new BackupStore(dir, { keep: 10, ttlMs: 0, maxBytes: 250 });
  for (let i = 0; i < 4; i++) {
    writeFileSync(src, "x".repeat(100) + `\n`);
    store.capture(src);
  }
  assertEq(store.count(), 2, "only the newest backups fit under the cap");
});

test("backup-store: prune is a no-op on a missing directory", () => {
  const store = new BackupStore(join(scratchDir(), "backups-missing"), baseOpts);
  store.prune();
  assertEq(store.count(), 0);
});
