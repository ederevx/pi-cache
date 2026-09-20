/**
 * pi-cache — ledger backup store.
 *
 * One responsibility: capture the ledger bytes before a retention rewrite
 * and keep the backup directory bounded — newest `keep`, TTL, and total
 * size — so a recovery copy is always available without the backups
 * growing forever. Every operation is best-effort.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

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
  private seq = 0;
  private readonly now: () => number;

  constructor(
    private readonly dir: string,
    private readonly opts: BackupOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Copy `source` into the store, then enforce the retention policy. */
  capture(source: string): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const seq = this.seq++;
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
      const stem = basename(source, extname(source));
      copyFileSync(source, join(this.dir, `${stamp}-${seq}-${stem}.jsonl`));
    } catch {
      /* a backup is best-effort; never break the caller */
    }
    this.prune();
  }

  /** Bound the store by ring, TTL, and total size. */
  prune(): void {
    this.applyRing(this.list());
    this.applyTtl(this.list());
    this.applySize(this.list());
  }

  /** Keep only the newest `keep` backups. */
  private applyRing(files: BackupFile[]): void {
    for (const file of files.slice(this.opts.keep)) this.remove(file.path);
  }

  /** Drop backups older than the TTL. */
  private applyTtl(files: BackupFile[]): void {
    if (this.opts.ttlMs <= 0) return;
    const cutoff = this.now() - this.opts.ttlMs;
    for (const file of files) if (file.mtimeMs < cutoff) this.remove(file.path);
  }

  /** Keep the newest backups up to the total-size cap. */
  private applySize(files: BackupFile[]): void {
    if (this.opts.maxBytes <= 0) return;
    let total = 0;
    for (const file of files) {
      if (total + file.size > this.opts.maxBytes) {
        this.remove(file.path);
        continue;
      }
      total += file.size;
    }
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
