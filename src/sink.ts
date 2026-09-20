/**
 * pi-cache — file ledger sink.
 *
 * One responsibility: own the ledger bytes — append rows, rehydrate them,
 * atomically rewrite the retained window, and flush queued appends. Errors
 * are swallowed (fail-open): telemetry must never break the session.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RecordSink, UsageRow } from "./ledger.ts";

export class FileRecordSink implements RecordSink {
  private prepared = false;
  /** Serializes appends; `flush` awaits the chain. */
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(row: UsageRow): void {
    this.pending = this.pending.then(() => this.appendAsync(row));
  }

  load(): UsageRow[] {
    try {
      const text = readFileSync(this.path, "utf8");
      const rows: UsageRow[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const row = JSON.parse(trimmed) as UsageRow;
          if (row && typeof row.id === "string" && typeof row.seq === "number") rows.push(row);
        } catch {
          /* torn or foreign lines are skipped */
        }
      }
      return rows;
    } catch {
      return [];
    }
  }

  /** Replace the file with `rows` atomically (same-dir temp + rename). */
  rewrite(rows: UsageRow[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      const body = rows.map((row) => JSON.stringify(row)).join("\n");
      writeFileSync(tmp, body.length > 0 ? body + "\n" : "", "utf8");
      renameSync(tmp, this.path);
      this.prepared = true;
    } catch {
      /* telemetry must never break the session */
    }
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  private async appendAsync(row: UsageRow): Promise<void> {
    try {
      if (!this.prepared) {
        await mkdir(dirname(this.path), { recursive: true });
        this.prepared = true;
      }
      await appendFile(this.path, JSON.stringify(row) + "\n", "utf8");
    } catch {
      /* telemetry must never break the session */
    }
  }
}