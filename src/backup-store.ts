/**
 * pi-cache — ledger backup store.
 *
 * One responsibility: capture the ledger bytes before a retention rewrite
 * and keep the backup directory bounded — newest `keep`, TTL, and total
 * size. Every operation is best-effort.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { TempSweeper } from "./temp-sweep.ts";
import { AtomicFile } from "./atomic-file.ts";

export interface BackupOptions {
  /** Newest backups to retain (ring). */
  keep: number;
  /** Maximum age in ms before a backup is pruned (`0` disables). */
  ttlMs: number;
  /** Maximum total bytes retained (`0` disables). */
  maxBytes: number;
  /** Clock injection for TTL (`Date.now` by default). */
  now?: () => number;
}

interface BackupFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export class BackupStore {
  /** Grace before a crash-left atomic-write temp is swept. */
  private static readonly TEMP_STALE_MS = 60 * 60 * 1000;

  private seq = 0;
  private readonly now: () => number;
  /** The shared stale-temp sweeper owns this directory's abandoned temps. */
  private readonly sweeper = new TempSweeper(BackupStore.TEMP_STALE_MS);

  constructor(
    private readonly dir: string,
    private readonly opts: BackupOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Copy `source` into the store, then enforce the retention policy. */
  capture(source: string): void {
    this.storeCopy(source);
    this.prune();
  }

  /**
   * Copy `source` under a unique, atomic name: the pid plus a per-instance
   * sequence keeps sibling processes from overwriting one another's
   * pre-image, and the temp+rename move keeps a torn copy from counting
   * as a valid backup. Best-effort: a failure never breaks the caller.
   */
  private storeCopy(source: string): void {
    let tmp: string | undefined;
    try {
      mkdirSync(this.dir, { recursive: true });
      const seq = this.seq++;
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
      const stem = basename(source, extname(source));
      const final = join(this.dir, `${stamp}-${process.pid}-${seq}-${stem}.jsonl`);
      tmp = `${final}.tmp`;
      copyFileSync(source, tmp);
      AtomicFile.replace(tmp, final);
    } catch {
      if (tmp !== undefined) AtomicFile.discard(tmp);
    }
  }

  /** Bound the store by ring, TTL, and total size. Every policy keeps a
   *  prefix of the newest-first order, so one greedy pass over ring
   *  budget, TTL, and size cap keeps exactly the survivors the three
   *  sequential sweeps kept. */
  prune(): void {
    this.sweepTemps();
    let kept = 0;
    let bytes = 0;
    const cutoff = this.opts.ttlMs > 0 ? this.now() - this.opts.ttlMs : -Number.POSITIVE_INFINITY;
    for (const file of this.list()) {
      const over =
        kept >= this.opts.keep ||
        file.mtimeMs < cutoff ||
        (this.opts.maxBytes > 0 && bytes + file.size > this.opts.maxBytes);
      if (over) this.remove(file.path);
      else {
        kept++;
        bytes += file.size;
      }
    }
  }

  /** Remove an abandoned atomic-write temp left by a crash mid-capture. */
  private sweepTemps(): void {
    this.sweeper.sweep(this.dir);
  }

  /** Backups newest-first. */
  private list(): BackupFile[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => {
          const path = join(this.dir, name);
          const stat = statSync(path);
          return { path, mtimeMs: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
    } catch {
      return [];
    }
  }

  private remove(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      /* a later prune retries */
    }
  }
}
