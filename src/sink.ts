/**
 * pi-cache — file ledger sink.
 *
 * One responsibility: append serialized usage rows to a JSONL file under
 * the pi-cache dot-directory, creating the directory on demand. Errors
 * are swallowed (fail-open): telemetry must never break the session.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RecordSink, UsageRow } from "./ledger.ts";

export class FileRecordSink implements RecordSink {
  private prepared: boolean = false;

  constructor(private readonly path: string) {}

  append(row: UsageRow): void {
    void this.appendAsync(row);
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