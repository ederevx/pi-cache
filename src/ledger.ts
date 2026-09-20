/**
 * pi-cache — usage ledger.
 *
 * One responsibility: record per-request cache usage, keep in-memory
 * session totals, persist rows through an injected sink, and bound the
 * retained window so the ledger cannot grow without limit. Writing and
 * rewriting go through the sink so the file side stays a single owner.
 * Telemetry must never break the session, so failures are swallowed.
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
  /** Replace the persisted rows atomically (retention/compaction). */
  rewrite(rows: UsageRow[]): void;
  /** Resolve once every queued append has landed. */
  flush(): Promise<void>;
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
  private readonly sink: RecordSink;
  private readonly enabled: boolean;
  /** Retained row window; `<= 0` means unbounded. */
  private readonly maxRows: number;

  constructor(sink: RecordSink, enabled: boolean, maxRows: number = 0) {
    this.sink = sink;
    this.enabled = enabled;
    this.maxRows = maxRows > 0 ? maxRows : Number.POSITIVE_INFINITY;
    // Rehydrate rows persisted by earlier processes, deduped by id and
    // ordered (ts, seq). Bound the file at load; rewrite only when rows
    // were actually dropped.
    this.rows = this.normalize(sink.load());
    this.noteSeq();
    if (this.rows.length > this.maxRows) {
      this.trim();
      this.sink.rewrite(this.rows);
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
    this.trim();
  }

  /** Aggregated counters over the retained ledger window (all processes). */
  totals(): { input: number; cacheRead: number; cacheWrite: number; n: number } {
    return this.sumRows(this.rows);
  }

  /** Aggregated counters over this process's own rows only. */
  sessionTotals(): { input: number; cacheRead: number; cacheWrite: number; n: number } {
    return this.sumRows(this.sessionRows);
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

  /**
   * Re-read the file (picking up sibling processes' rows), trim to the
   * retained window, and rewrite the file when rows were dropped. Returns
   * whether the file was rewritten.
   */
  compact(): boolean {
    this.rows = this.normalize(this.sink.load());
    const before = this.rows.length;
    this.trim();
    if (this.rows.length === before) return false;
    this.sink.rewrite(this.rows);
    return true;
  }

  /** Resolve once every queued append has landed. */
  flush(): Promise<void> {
    return this.sink.flush();
  }

  /** Dedupe by id and order by (ts, seq); newest last. */
  private normalize(rows: UsageRow[]): UsageRow[] {
    const byId = new Map<string, UsageRow>();
    for (const row of rows) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }

  /** Keep `seq` ahead of every rehydrated row so new ids stay unique. */
  private noteSeq(): void {
    for (const row of this.rows) if (row.seq >= this.seq) this.seq = row.seq + 1;
  }

  /** Drop the oldest rows beyond the retained window. */
  private trim(): void {
    if (this.rows.length > this.maxRows) {
      this.rows.splice(0, this.rows.length - this.maxRows);
    }
    if (this.sessionRows.length > this.maxRows) {
      this.sessionRows.splice(0, this.sessionRows.length - this.maxRows);
    }
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
}