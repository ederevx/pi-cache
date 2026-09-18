/**
 * pi-cache — usage ledger.
 *
 * One responsibility: record per-request cache usage, keep in-memory
 * session totals, and persist rows to an append-only ledger. Writing goes
 * through an injected RecordSink so the class stays testable and the file
 * side stays a single owner. Telemetry must never break the session, so
 * persistence failures are swallowed (fail-open house rule).
 */

import type { Usage } from "@earendil-works/pi-ai";

/** A single recorded request row in the ledger. */
export interface UsageRow {
  seq: number;
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** Persistence seam: the ledger owns rows, the sink owns bytes. */
export interface RecordSink {
  append(row: UsageRow): void;
}

export class CacheLedger {
  private rows: UsageRow[] = [];
  private seq = 0;

  constructor(
    private readonly sink: RecordSink,
    private readonly enabled: boolean,
  ) {}

  /** Record one assistant message's usage, if present. */
  record(usage: Usage | undefined, model: string): void {
    if (!usage || !this.enabled) return;
    const row: UsageRow = {
      seq: this.seq++,
      ts: Date.now(),
      model,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    };
    this.rows.push(row);
    this.sink.append(row);
  }

  /** Aggregated counters for summaries and advisors. */
  totals(): { input: number; cacheRead: number; cacheWrite: number; n: number } {
    return this.rows.reduce(
      (a, r) => ({
        input: a.input + r.input,
        cacheRead: a.cacheRead + r.cacheRead,
        cacheWrite: a.cacheWrite + r.cacheWrite,
        n: a.n + 1,
      }),
      { input: 0, cacheRead: 0, cacheWrite: 0, n: 0 },
    );
  }

  /** Cache-ratio numerator over the session; 0 when nothing recorded. */
  cacheRatio(): number {
    const t = this.totals();
    const denom = t.input + t.cacheRead;
    return denom > 0 ? t.cacheRead / denom : 0;
  }

  /** One-line summary for the /cache-stats command and status widget. */
  summary(): string {
    const t = this.totals();
    if (t.n === 0) return "pi-cache: no usage recorded yet";
    return (
      `pi-cache: ${t.n} req, read ${t.cacheRead.toLocaleString()} / ` +
      `in ${t.input.toLocaleString()} (${(this.cacheRatio() * 100).toFixed(1)}%), ` +
      `writes ${t.cacheWrite.toLocaleString()}`
    );
  }
}