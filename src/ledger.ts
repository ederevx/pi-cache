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
  /** Globally-unique row id `${pid}:${boot}:${seq}` — valid across processes
   *  and reloads that share one ledger file (a bare per-process counter
   *  collides when multiple pi processes append to the same sink). */
  id: string;
  seq: number;
  ts: number;
  /** Owning pi process (distinguishes sibling/worker processes appending
   *  to the same ledger file). */
  pid: number;
  /** Session identity when known; "session" otherwise. */
  session: string;
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
  /** All rows currently persisted on disk (for rehydration on load). */
  load(): UsageRow[];
}

export class CacheLedger {
  private rows: UsageRow[] = [];
  /** This process's own rows only — the auto-compaction trigger reads these
   *  last-usage/gap signals from the live session, never from rehydrated
   *  history. */
  private sessionRows: UsageRow[] = [];
  private seq = 0;
  /** Per-process boot nonce so row ids are unique across reloads. */
  private boot = Math.floor(Math.random() * 0x10000).toString(16);
  private readonly seen = new Set<string>();

  constructor(
    private readonly sink: RecordSink,
    private readonly enabled: boolean,
  ) {
    // Rehydrate rows persisted by earlier processes so totals/summary are
    // cumulative, deduped by the globally-unique row id.
    for (const row of this.sink.load()) {
      if (this.seen.has(row.id)) continue;
      this.seen.add(row.id);
      this.rows.push(row);
      if (row.seq >= this.seq) this.seq = row.seq + 1;
    }
  }

  /** Record one assistant message's usage, if present. */
  record(usage: Usage | undefined, model: string, session: string = "session"): void {
    if (!usage || !this.enabled) return;
    const row: UsageRow = {
      id: `${process.pid}:${this.boot}:${this.seq}`,
      seq: this.seq++,
      ts: Date.now(),
      pid: process.pid,
      session,
      model,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    };
    this.rows.push(row);
    this.sessionRows.push(row);
    this.sink.append(row);
  }

  /** Aggregated counters over the whole ledger (all processes). */
  totals(): { input: number; cacheRead: number; cacheWrite: number; n: number } {
    return this.sumRows(this.rows);
  }

  /** Aggregated counters over this process's own rows only. */
  sessionTotals(): { input: number; cacheRead: number; cacheWrite: number; n: number } {
    return this.sumRows(this.sessionRows);
  }

  private sumRows(rows: UsageRow[]): {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    n: number;
  } {
    return rows.reduce(
      (a, r) => ({
        input: a.input + r.input,
        cacheRead: a.cacheRead + r.cacheRead,
        cacheWrite: a.cacheWrite + r.cacheWrite,
        n: a.n + 1,
      }),
      { input: 0, cacheRead: 0, cacheWrite: 0, n: 0 },
    );
  }

  /** Last completed turn's usage (this process only), for the
   *  auto-compaction trigger. */
  lastUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined {
    const last = this.sessionRows[this.sessionRows.length - 1];
    return last ? { input: last.input, cacheRead: last.cacheRead, cacheWrite: last.cacheWrite } : undefined;
  }

  /** Milliseconds since the last recorded turn ended (this process only). */
  msSinceLastTurn(): number {
    const last = this.sessionRows[this.sessionRows.length - 1];
    return last ? Date.now() - last.ts : Number.POSITIVE_INFINITY;
  }
}
