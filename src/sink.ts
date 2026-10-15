/**
 * pi-cache — file ledger sink.
 *
 * One responsibility: own the ledger bytes — append rows, parse the
 * evicted-row baseline and rows, and run locked read-modify-write retention
 * — with every operation serialized by a same-dir lock so sibling processes
 * cannot clobber each other. Appends are never written outside the lock: a
 * row that cannot be committed is reported as failed rather than counted, so
 * the lifetime totals stay tied to persisted bytes. Errors are fail-open
 * (telemetry must never break the session): a failed transaction returns the
 * last good snapshot.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AtomicFile } from "./atomic-file.ts";
import type { BackupStore } from "./backup-store.ts";
import {
  LEDGER_BASELINE_TYPE,
  type LedgerSnapshot,
  type RecordSink,
  type SinkCommit,
  type UsageRow,
  type UsageTotals,
} from "./ledger.ts";

/** Grace before a same-named lock left by a crash is considered stale. */
const LOCK_STALE_MS = 30_000;

export class FileRecordSink implements RecordSink {
  private prepared = false;
  /** Last snapshot this sink managed to read or write; fail-open fallback. */
  private lastGood: LedgerSnapshot;

  /** Synchronous short sleep; never used on the hot path. */
  private static sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  constructor(
    private readonly path: string,
    private readonly backups?: BackupStore,
  ) {
    this.lastGood = { baseline: FileRecordSink.zeroTotals(), rows: [] };
  }

  load(): LedgerSnapshot {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (FileRecordSink.isMissing(error)) {
        return { baseline: FileRecordSink.zeroTotals(), rows: [] };
      }
      throw error;
    }
    const snapshot = this.parse(text);
    this.lastGood = snapshot;
    return snapshot;
  }

  /**
   * Locked read-modify-write: load the file, hand `keep` the snapshot, and
   * atomically persist only when `keep` returns a different object. The lock
   * is held across load and write, so a concurrent append cannot be lost;
   * when the write cannot run, the last good snapshot is returned unchanged.
   */
  transform(keep: (snapshot: LedgerSnapshot) => LedgerSnapshot): SinkCommit {
    let commit: SinkCommit | undefined;
    this.underLock(() => {
      const raw = this.load();
      const next = keep(raw);
      if (next === raw) {
        commit = { snapshot: raw, rewritten: false };
        return;
      }
      // A shrinking row rewrite would drop rows: keep a recovery copy.
      if (this.backups && next.rows.length < raw.rows.length) this.backups.capture(this.path);
      this.writeAtomic(next);
      this.lastGood = next;
      commit = { snapshot: next, rewritten: true };
    });
    return commit ?? { snapshot: this.lastGood, rewritten: false };
  }

  /** Replace the file with exactly `snapshot` (convenience over transform). */
  rewrite(snapshot: LedgerSnapshot): SinkCommit {
    return this.transform(() => snapshot);
  }

  async flush(): Promise<void> {
    /* appends are synchronous under the lock; nothing is queued */
  }

  /** Parse the baseline header plus usage rows; skip torn/foreign lines. */
  private parse(text: string): LedgerSnapshot {
    let baseline: UsageTotals | undefined;
    const rows: UsageRow[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        continue; // torn or foreign lines are skipped
      }
      if (FileRecordSink.isBaseline(parsed)) {
        if (baseline !== undefined) throw new Error("duplicate ledger baseline");
        baseline = FileRecordSink.readBaseline(parsed);
        continue;
      }
      if (parsed !== null && typeof parsed === "object") rows.push(parsed as UsageRow);
    }
    return { baseline: baseline ?? FileRecordSink.zeroTotals(), rows };
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

  /** Append one row under the lock; false when it did not commit. */
  append(row: UsageRow): boolean {
    return this.underLock(() => this.appendBytes(row));
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

  /** Write the baseline header (when non-empty) plus rows atomically,
   *  preserving the current permissions (owner-only by default). */
  private writeAtomic(snapshot: LedgerSnapshot): void {
    const lines: string[] = [];
    if (snapshot.baseline.n > 0) {
      lines.push(JSON.stringify({ _type: LEDGER_BASELINE_TYPE, version: 1, ...snapshot.baseline }));
    }
    for (const row of snapshot.rows) lines.push(JSON.stringify(row));
    const body = lines.join("\n");
    AtomicFile.write(
      this.path,
      body.length > 0 ? body + "\n" : "",
      AtomicFile.modeOf(this.path, 0o600),
    );
  }

  private static isMissing(error: unknown): boolean {
    return (
      error !== null &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }

  private static isBaseline(value: unknown): boolean {
    return (
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>)["_type"] === LEDGER_BASELINE_TYPE
    );
  }

  /** Validate one baseline line; reject unsupported or malformed metadata. */
  private static readBaseline(value: unknown): UsageTotals {
    const v = value as Record<string, unknown>;
    if (v.version !== 1) throw new Error("unsupported ledger baseline version");
    const fields = [v.n, v.input, v.cacheRead, v.cacheWrite];
    const valid = fields.every(
      (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
    );
    if (!valid) throw new Error("invalid ledger baseline");
    return {
      n: v.n as number,
      input: v.input as number,
      cacheRead: v.cacheRead as number,
      cacheWrite: v.cacheWrite as number,
    };
  }

  private static zeroTotals(): UsageTotals {
    return { input: 0, cacheRead: 0, cacheWrite: 0, n: 0 };
  }
}
