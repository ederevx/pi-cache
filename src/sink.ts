/**
 * pi-cache — file ledger sink.
 *
 * One responsibility: own the ledger bytes — append rows, rehydrate them,
 * and run locked read-modify-write retention — with every operation
 * serialized by a same-dir lock so sibling processes cannot clobber each
 * other. Errors are swallowed (fail-open): telemetry must never break the
 * session.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AtomicFile } from "./atomic-file.ts";
import type { BackupStore } from "./backup-store.ts";
import type { RecordSink, UsageRow } from "./ledger.ts";

/** Grace before a same-named lock left by a crash is considered stale. */
const LOCK_STALE_MS = 30_000;

export class FileRecordSink implements RecordSink {
  private prepared = false;

  /** Synchronous short sleep; never used on the hot path. */
  private static sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  constructor(
    private readonly path: string,
    private readonly backups?: BackupStore,
  ) {}

  load(): UsageRow[] {
    try {
      return this.parse(readFileSync(this.path, "utf8"));
    } catch {
      return [];
    }
  }

  /**
   * Locked read-modify-write: load the file, hand `keep` the rows, and
   * atomically persist only when `keep` returns a different array. The lock
   * is held across load and write, so a concurrent append cannot be lost.
   */
  transform(keep: (rows: UsageRow[]) => UsageRow[]): void {
    this.underLock(() => {
      const raw = this.load();
      const next = keep(raw);
      if (next === raw) return;
      // A shrinking rewrite would drop rows: keep a bounded recovery copy.
      if (this.backups && next.length < raw.length) this.backups.capture(this.path);
      this.writeAtomic(next.slice());
    });
  }

  /** Replace the file with exactly `rows` (convenience over `transform`). */
  rewrite(rows: UsageRow[]): void {
    this.transform(() => rows);
  }

  async flush(): Promise<void> {
    /* appends are synchronous under the lock; nothing is queued */
  }

  /** Parse JSONL, skipping torn or foreign lines. */
  private parse(text: string): UsageRow[] {
    const rows: UsageRow[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const row = JSON.parse(trimmed) as unknown;
        if (row !== null && typeof row === "object") rows.push(row as UsageRow);
      } catch {
        /* torn or foreign lines are skipped */
      }
    }
    return rows;
  }

  /** Create the ledger directory once; sole owner of `prepared`. */
  private ensureDir(): void {
    if (this.prepared) return;
    mkdirSync(dirname(this.path), { recursive: true });
    this.prepared = true;
  }

  /** Ensure the directory, then run `fn` holding the rewrite lock.
   *  Fail-open: false means the lock was unavailable or `fn` threw
   *  (telemetry must never break the session); the lock is always
   *  released. */
  private underLock(fn: () => void): boolean {
    try {
      this.ensureDir();
    } catch {
      /* an unwritable ledger dir disables persistence, never the session */
      return false;
    }
    const lock = this.acquireLockWithRetry();
    if (lock === undefined) return false;
    try {
      fn();
      return true;
    } catch {
      return false;
    } finally {
      try {
        rmSync(lock, { force: true });
      } catch {
        /* a later sweep clears a leaked lock */
      }
    }
  }

  append(row: UsageRow): void {
    // Prefer the lock so a concurrent rewrite cannot clobber the row; retry
    // briefly under contention, then append unlocked rather than drop it.
    if (this.underLock(() => this.appendBytes(row))) return;
    try {
      this.ensureDir();
      this.appendBytes(row);
    } catch {
      /* telemetry must never break the session */
    }
  }

  /** Serialize one row onto the ledger file; callers own the lock and dir. */
  private appendBytes(row: UsageRow): void {
    appendFileSync(this.path, JSON.stringify(row) + "\n", "utf8");
  }

  /** Retry the lock briefly so a short rewrite does not drop an append. */
  private acquireLockWithRetry(): string | undefined {
    for (let attempt = 0; attempt < 20; attempt++) {
      const lock = this.acquireLock();
      if (lock !== undefined) return lock;
      FileRecordSink.sleep(1);
    }
    return undefined;
  }

  /** Acquire the rewrite lock, clearing a stale one; undefined on contention. */
  private acquireLock(): string | undefined {
    const lock = `${this.path}.lock`;
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return lock;
    } catch {
      if (!this.clearStaleLock(lock)) return undefined;
      try {
        writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
        return lock;
      } catch {
        return undefined;
      }
    }
  }

  /** Remove a lock older than the grace period; true when it was stale. */
  private clearStaleLock(lock: string): boolean {
    try {
      if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return false;
      rmSync(lock, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Write all rows to a sibling temp file and rename it over the ledger,
   *  preserving the current permissions (owner-only by default). */
  private writeAtomic(rows: UsageRow[]): void {
    const body = rows.map((row) => JSON.stringify(row)).join("\n");
    AtomicFile.write(
      this.path,
      body.length > 0 ? body + "\n" : "",
      AtomicFile.modeOf(this.path, 0o600),
    );
  }
}
