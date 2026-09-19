/**
 * pi-cache — file ledger sink.
 *
 * One responsibility: append serialized usage rows to a JSONL file under
 * the pi-cache dot-directory, creating the directory on demand. Errors
 * are swallowed (fail-open): telemetry must never break the session.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RecordSink, UsageRow } from "./ledger.ts";

export class FileRecordSink implements RecordSink {
  private prepared: boolean = false;

  constructor(private readonly path: string) {}

  append(row: UsageRow): void {
    void this.appendAsync(row);
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