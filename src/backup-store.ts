/**
 * pi-cache — ledger backup store.
 *
 * One responsibility: capture the ledger bytes before a retention rewrite
 * and keep the backup directory bounded — newest `keep`, TTL, and total
 * size — so a recovery copy is always available without the backups
 * growing forever. Every operation is best-effort.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface BackupOptions {
  /** Newest backups to retain (ring). */
  keep: number;
  /** Maximum age in ms before a backup is pruned (`0` disables). */
  ttlMs: number;
  /** Maximum total bytes retained (`0` disables). */
  maxBytes: number;
}

interface BackupFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export class BackupStore {
  private seq = 0;

  constructor(
    private readonly dir: string,
    private readonly opts: BackupOptions,
  ) {}

  /** Copy `source` into the store, then enforce the retention limits. */
  capture(source: string): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(source, join(this.dir, `${stamp}-${this.seq++}-${basename(source)}`));
    } catch {
      /* a backup is best-effort; never break the caller */
    }
    this.prune();
  }

  /** Bound the store by ring, TTL, and total size. */
  prune(): void {
    const files = this.list();
    for (const file of files.slice(this.opts.keep)) this.remove(file.path);
    if (this.opts.ttlMs > 0) {
      const cutoff = Date.now() - this.opts.ttlMs;
      for (const file of files) if (file.mtimeMs < cutoff) this.remove(file.path);
    }
    if (this.opts.maxBytes > 0) {
      let total = 0;
      for (const file of this.list()) {
        if (total + file.size > this.opts.maxBytes) {
          this.remove(file.path);
          continue;
        }
        total += file.size;
      }
    }
  }

  /** Number of backups currently retained. */
  count(): number {
    return this.list().length;
  }

  /** The owned backup directory. */
  path(): string {
    return this.dir;
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
