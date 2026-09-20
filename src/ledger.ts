/**
 * pi-cache — usage ledger.
 *
 * One responsibility: record per-request cache usage, keep global and
 * current-session totals, persist rows through an injected sink, and bound
 * the retained window so the ledger cannot grow without limit. Writing and
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
  /** Replace the persisted rows atomically; snapshot `rows` at call time. */
  rewrite(rows: UsageRow[]): void;
  /** Resolve once every queued append has landed. */
  flush(): Promise<void>;
}

export class CacheLedger {
  private rows: UsageRow[] = [];
  /** Rows belonging to the current session id, rebuilt from the retained
   *  window by `useSession` so session stats survive reloads. Empty until
   *  the id is known; the auto-compaction trigger reads its last row. */
  private sessionRows: UsageRow[] = [];
  private seq = 0;
  /** Per-process boot nonce so row ids are unique across reloads. */
  private boot = Math.floor(Math.random() * 0x10000).toString(16);
  private readonly sink: RecordSink;
  private readonly enabled: boolean;
  /** Retained row window; `<= 0` means unbounded. */
  private readonly maxRows: number;
  /** True when the last merge dropped duplicate lines from disk. */
  private duplicateLines = false;
  /** The active session identity, once known. */
  private sessionId: string | undefined;

  constructor(sink: RecordSink, enabled: boolean, maxRows: number = 0) {
    this.sink = sink;
    this.enabled = enabled;
    this.maxRows = maxRows > 0 ? maxRows : Number.POSITIVE_INFINITY;
    this.mergeLatest();
    this.noteSeq();
    this.retain();
  }

  /** Adopt the active session id and rebuild its persisted row window. */
  useSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.sessionRows = this.rows.filter((row) => row.session === sessionId);
    this.trim();
  }

  /** Record one assistant message's usage, if present. */
  record(usage: Usage | undefined, model: string, session: string = this.sessionId ?? "session"): void {
    if (!usage || !this.enabled) return;
    const row = this.buildRow(usage, model, session);
    this.rows.push(row);
    if (this.sessionId === undefined || row.session === this.sessionId) {
      this.sessionRows.push(row);
    }
    this.sink.append(row);
    this.trim();
  }

  /** Aggregated counters over the retained ledger window (all processes). */
  totals(): { input: number; cacheRead: number; cacheWrite: number; n: number } {
    return this.sumRows(this.rows);
  }

  /** Aggregated counters over the current session's retained rows. */
  sessionTotals(): { input: number; cacheRead: number; cacheWrite: number; n: number } {
    return this.sumRows(this.sessionRows);
  }

  /** Last completed turn's usage for the current session, for the
   *  auto-compaction trigger. */
  lastUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined {
    const last = this.sessionRows[this.sessionRows.length - 1];
    return last ? { input: last.input, cacheRead: last.cacheRead, cacheWrite: last.cacheWrite } : undefined;
  }

  /** Milliseconds since the current session's last recorded turn ended. */
  msSinceLastTurn(): number {
    const last = this.sessionRows[this.sessionRows.length - 1];
    return last ? Date.now() - last.ts : Number.POSITIVE_INFINITY;
  }

  /** Flush queued appends, then bound the file; call once at shutdown. */
  async close(): Promise<void> {
    await this.flush();
    this.compact();
  }

  /**
   * Merge the freshest on-disk rows and rewrite the file when the retained
   * window dropped anything. Callers that may have pending appends should
   * `flush()` first so the rewrite is the last write.
   */
  compact(): boolean {
    this.mergeLatest();
    return this.retain();
  }

  /** Resolve once every queued append has landed. */
  flush(): Promise<void> {
    return this.sink.flush();
  }

  /** Merge fresh disk rows into memory so a rewrite cannot drop sibling appends. */
  private mergeLatest(): void {
    const raw = this.sink.load();
    const normalizedRaw = this.normalize(raw);
    this.duplicateLines = normalizedRaw.length < raw.length;
    this.rows = this.normalize([...this.rows, ...raw]);
  }

  /** Trim to the retained window; rewrite the file if anything was dropped. */
  private retain(): boolean {
    const dropped = this.trim();
    if (!dropped && !this.duplicateLines) return false;
    this.sink.rewrite(this.rows.slice());
    this.duplicateLines = false;
    return true;
  }

  /** Keep `seq` ahead of every rehydrated row so new ids stay unique. */
  private noteSeq(): void {
    for (const row of this.rows) if (row.seq >= this.seq) this.seq = row.seq + 1;
  }

  /** Build one ledger row from a recorded usage. */
  private buildRow(usage: Usage, model: string, session: string): UsageRow {
    return {
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
  }

  /** Dedupe valid rows by id and order by (ts, seq); newest last. */
  private normalize(rows: UsageRow[]): UsageRow[] {
    const byId = new Map<string, UsageRow>();
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || typeof row.seq !== "number") continue;
      byId.set(row.id, row);
    }
    return [...byId.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }

  /** Drop oldest rows beyond the window; returns whether either list shrank. */
  private trim(): boolean {
    const rowsBefore = this.rows.length;
    const sessionBefore = this.sessionRows.length;
    this.rows = this.trimToWindow(this.rows);
    this.sessionRows = this.trimToWindow(this.sessionRows);
    return this.rows.length !== rowsBefore || this.sessionRows.length !== sessionBefore;
  }

  /** Keep only the newest `maxRows` entries of one collection. */
  private trimToWindow(rows: UsageRow[]): UsageRow[] {
    return rows.length > this.maxRows ? rows.slice(rows.length - this.maxRows) : rows;
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
