/**
 * pi-cache — usage ledger.
 *
 * One responsibility: record per-request cache usage, keep global and
 * current-session totals, persist rows through an injected sink, and bound
 * the retained window so the ledger cannot grow without limit. Writing and
 * retention go through the sink so the file side stays a single owner.
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
  /** pi-cache's coldness-ramp TTL view (ms) at record time. Optional so
   *  older ledger files without the field stay valid append-compatible. */
  cacheTtlMs?: number;
  /** pi's tier-or-undefined warming view (ms); omitted when pi has no
   *  tier for the model, so absence itself carries signal. */
  piTtlMs?: number;
  /** True when the request ran on the long retention tier. */
  retentionLong?: boolean;
  /** True when the cache was warm (a touch within the effective TTL)
   *  when this request was recorded. */
  warm?: boolean;
  /** Age (ms) of the last cache touch at record time; omitted when the
   *  cache was never touched in the session. */
  msSinceCacheTouch?: number;
}

/** Per-request cache state a caller attaches to a row. Every field is
 *  optional; omitted fields keep the row identical to the old schema. */
export interface RecordExtras {
  cacheTtlMs?: number;
  piTtlMs?: number;
  retentionLong?: boolean;
  warm?: boolean;
  msSinceCacheTouch?: number;
}

/** Persistence seam: the ledger owns rows, the sink owns bytes. */
export interface RecordSink {
  append(row: UsageRow): void;
  /** All rows currently persisted on disk (for rehydration on load). */
  load(): UsageRow[];
  /**
   * Locked read-modify-write: load the rows, call `keep`, and persist the
   * returned array atomically. Returning the same array means "unchanged".
   */
  transform(keep: (rows: UsageRow[]) => UsageRow[]): void;
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
  /** Appends since the last in-session file compaction (see record). */
  private appendsSinceCompact = 0;
  /** Per-process boot nonce so row ids are unique across reloads. */
  private boot = Math.floor(Math.random() * 0x10000).toString(16);
  private readonly sink: RecordSink;
  private enabledOn: boolean;
  /** Retained row window; `<= 0` means unbounded. */
  private readonly maxRows: number;
  /** The active session identity, once known. */
  private sessionId: string | undefined;

  constructor(sink: RecordSink, enabled: boolean, maxRows: number = 0) {
    this.sink = sink;
    this.enabledOn = enabled;
    this.maxRows = maxRows > 0 ? maxRows : Number.POSITIVE_INFINITY;
    this.enforceRetention();
    this.noteSeq();
  }

  /** Adopt the active session id and rebuild its persisted row window. */
  useSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.sessionRows = this.rows.filter((row) => row.session === sessionId);
  }

  /** The live telemetry switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.enabledOn;
  }

  /** Turn ledger recording on or off in place. */
  setEnabled(enabled: boolean): void {
    this.enabledOn = enabled;
  }

  /** Record one assistant message's usage, if present. Returns the
   *  recorded row so collaborators (TTL learner, miss classifier) can feed
   *  on it without re-reading the ledger; undefined when nothing recorded. */
  record(
    usage: Usage | undefined,
    model: string,
    session: string = this.sessionId ?? "session",
    extras: RecordExtras = {},
  ): UsageRow | undefined {
    if (!usage || !this.enabledOn) return undefined;
    const row = this.buildRow(usage, model, session, extras);
    this.rows.push(row);
    this.noteSessionRow(row);
    this.sink.append(row);
    this.trim();
    this.maybeCompactFile();
    return row;
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

  /** Globally-unique id of the current session's last row, if any. */
  lastRowId(): string | undefined {
    const last = this.sessionRows[this.sessionRows.length - 1];
    return last?.id;
  }

  /** Flush queued appends, then bound the file; call once at shutdown. */
  async close(): Promise<void> {
    await this.flush();
    this.compact();
  }

  /**
   * Locked read-modify-write retention: merge the freshest disk rows,
   * reclaim duplicates, trim to the window, and persist only when
   * something changed. Returns whether the file was rewritten.
   */
  compact(): boolean {
    return this.enforceRetention();
  }

  /** Resolve once every queued append has landed. */
  flush(): Promise<void> {
    return this.sink.flush();
  }

  /** Bound the file inside the sink's lock; true when it was rewritten. */
  private enforceRetention(): boolean {
    let changed = false;
    // The callback mutates this ledger's own rows (owner-initiated) and
    // returns the snapshot the sink should persist; the sink never keeps
    // a live reference to them.
    this.sink.transform((raw) => {
      const duplicates = this.normalize(raw).length < raw.length;
      this.rows = this.normalize([...this.rows, ...raw]);
      const dropped = this.trim();
      changed = duplicates || dropped;
      return changed ? this.rows.slice() : raw;
    });
    return changed;
  }

  /** Keep `seq` ahead of every rehydrated row so new ids stay unique. */
  private noteSeq(): void {
    for (const row of this.rows) if (row.seq >= this.seq) this.seq = row.seq + 1;
  }

  /** Build one ledger row from a recorded usage. */
  private buildRow(usage: Usage, model: string, session: string, extras: RecordExtras = {}): UsageRow {
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
      ...extras,
    };
  }

  /** Route a row to the session window only when it belongs to this session. */
  private noteSessionRow(row: UsageRow): void {
    if (this.sessionId === undefined || row.session === this.sessionId) {
      this.sessionRows.push(row);
    }
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

  /**
   * Bound the file during a long session, not only at load/shutdown: after
   * one full window of appends the file holds the window plus those appends,
   * so rewrite it to the retained set. A no-op when unbounded.
   */
  private maybeCompactFile(): void {
    if (this.maxRows === Number.POSITIVE_INFINITY) return;
    this.appendsSinceCompact++;
    if (this.appendsSinceCompact < this.maxRows) return;
    this.appendsSinceCompact = 0;
    this.enforceRetention();
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
