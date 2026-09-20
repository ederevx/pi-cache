/**
 * pi-cache — file ledger sink.
 *
 * One responsibility: own the ledger bytes — append rows, rehydrate them,
 * atomically rewrite the retained window, and flush queued appends. Errors
 * are swallowed (fail-open): telemetry must never break the session.
 */

import { appendFile } from "node:fs/promises";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RecordSink, UsageRow } from "./ledger.ts";

/** Grace before a same-named lock left by a crash is considered stale. */
const LOCK_STALE_MS = 30_000;

export class FileRecordSink implements RecordSink {
  private prepared = false;
  /** Serializes appends; `flush` awaits the chain. */
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(row: UsageRow): void {
    this.pending = this.pending.then(() => this.appendRow(row));
  }

  load(): UsageRow[] {
    try {
      return this.parse(readFileSync(this.path, "utf8"));
    } catch {
      return [];
    }
  }

  /**
   * Replace the file with a snapshot of `rows` atomically. Callers that may
   * have pending appends should `flush()` first so the rewrite is the last
   * write. A best-effort lock keeps concurrent rewrites from clobbering
   * each other; on lock contention this pass is skipped.
   */
  rewrite(rows: UsageRow[]): void {
    const snapshot = rows.slice();
    this.ensureDir();
    const lock = this.acquireLock();
    if (lock === undefined) return;
    try {
      this.writeAtomic(snapshot);
    } catch {
      /* telemetry must never break the session */
    } finally {
      rmSync(lock, { force: true });
    }
  }

  async flush(): Promise<void> {
    await this.pending;
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

  /** Acquire the rewrite lock, clearing a stale one; undefined on contention. */
  private acquireLock(): string | undefined {
    const lock = `${this.path}.lock`;
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return lock;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
          return lock;
        }
      } catch {
        /* lock vanished or is unreadable; treat as contention */
      }
      return undefined;
    }
  }

  /** Write all rows to a sibling temp file and rename it over the ledger. */
  private writeAtomic(rows: UsageRow[]): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    const body = rows.map((row) => JSON.stringify(row)).join("\n");
    writeFileSync(tmp, body.length > 0 ? body + "\n" : "", {
      encoding: "utf8",
      mode: this.existingMode(),
    });
    renameSync(tmp, this.path);
  }

  /** Preserve the ledger's current permissions; default to owner-only. */
  private existingMode(): number {
    try {
      return statSync(this.path).mode & 0o777;
    } catch {
      return 0o600;
    }
  }

  private async appendRow(row: UsageRow): Promise<void> {
    try {
      this.ensureDir();
      await appendFile(this.path, JSON.stringify(row) + "\n", "utf8");
    } catch {
      /* telemetry must never break the session */
    }
  }
}
