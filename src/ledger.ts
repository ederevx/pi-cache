/**
 * pi-cache — usage ledger.
 *
 * One responsibility: record per-request cache usage, keep global lifetime
 * and current-session totals, persist rows through an injected sink, and
 * bound the retained row window so the ledger cannot grow without limit.
 * Global totals survive eviction: rows dropped from the window are folded
 * into a baseline persisted inside the same file, so `global = baseline +
 * retained rows` holds at every committed state. Writing and retention go
 * through the sink so the file side stays a single owner. Telemetry must
 * never break the session, so persistence failures are reported rather than
 * thrown.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

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
  /** Row kind, owned exclusively by the ledger: `"turn"` for a real
   *  assistant turn, `"warm"` for a warm-refresh telemetry row. Absent in
   *  rows written before the field existed, which are all turns. Never
   *  place this in {@link RecordExtras}: a caller must not be able to
   *  relabel a turn as a refresh or the reverse. */
  kind?: "turn" | "warm";
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

/** Aggregated cache counters over some set of rows. */
export interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  n: number;
}

/** Persisted grand total of rows already evicted from the retained window. */
export interface LedgerBaseline extends UsageTotals {
  _type: "pi-cache-ledger-baseline";
  version: 1;
}

/** One complete ledger document: the evicted-row baseline plus retained rows. */
export interface LedgerSnapshot {
  baseline: UsageTotals;
  rows: UsageRow[];
}

/** Outcome of a locked snapshot transaction. */
export interface SinkCommit {
  /** The committed snapshot (the unchanged one when nothing was written). */
  snapshot: LedgerSnapshot;
  /** True when the transaction replaced the file. */
  rewritten: boolean;
}

/** Persistence seam: the ledger owns rows, the sink owns bytes. */
export interface RecordSink {
  /** Append one row; false when the write did not commit (never silently
   *  counted, so global totals stay tied to persisted rows). */
  append(row: UsageRow): boolean;
  /** All rows and the evicted-row baseline currently persisted on disk. */
  load(): LedgerSnapshot;
  /**
   * Locked read-modify-write: load the snapshot, call `keep`, and persist
   * the returned snapshot atomically. Returning the same object means
   * "unchanged". The committed snapshot is returned even when the write
   * could not run (fail-open telemetry).
   */
  transform(keep: (snapshot: LedgerSnapshot) => LedgerSnapshot): SinkCommit;
  /** Resolve once every queued append has landed. */
  flush(): Promise<void>;
}

/** Marker `_type` of the in-file evicted-row baseline line. */
export const LEDGER_BASELINE_TYPE = "pi-cache-ledger-baseline";

export class CacheLedger {
  private rows: UsageRow[] = [];
  /** Rows belonging to the current session id, rebuilt from the retained
   *  window by `useSession` so session stats survive reloads. Empty until
   *  the id is known; the auto-compaction trigger reads its last row. */
  private sessionRows: UsageRow[] = [];
  /** Lifetime totals of rows already evicted from the retained window. */
  private baseline: UsageTotals = CacheLedger.zeroTotals();
  private seq = 0;
  /** Appends since the last in-session file compaction (see record). */
  private appendsSinceCompact = 0;
  /** Per-process boot nonce so row ids are unique across reloads. */
  private readonly boot = randomUUID();
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
    return this.append(usage, model, session, extras, "turn");
  }

  /** The one append path, with the ledger as the sole writer of `kind`. */
  private append(
    usage: Usage | undefined,
    model: string,
    session: string,
    extras: RecordExtras,
    kind: UsageRow["kind"],
  ): UsageRow | undefined {
    if (!usage || !this.enabledOn) return undefined;
    const row = this.buildRow(usage, model, session, extras, kind);
    // Only a persisted row may count; a failed write is not telemetry.
    if (!this.sink.append(row)) return undefined;
    this.rows.push(row);
    this.noteSessionRow(row);
    this.trim();
    this.maybeCompactFile();
    return row;
  }

  /** Lifetime counters across every recorded row (retained + evicted). */
  totals(): UsageTotals {
    return this.addTotals(this.baseline, this.sumRows(this.rows));
  }

  /** Counters over the retained window only (no evicted baseline). */
  retainedTotals(): UsageTotals {
    return this.sumRows(this.rows);
  }

  /** Aggregated counters over the current session's retained rows. */
  sessionTotals(): UsageTotals {
    return this.sumRows(this.sessionRows);
  }

  /** Last completed turn's usage for the current session, for the
   *  auto-compaction trigger. Warm-refresh telemetry rows (`kind`
   *  `"warm"`) are not turns: the accessors below skip them so a
   *  background refresh can never masquerade as turn activity. The
   *  telemetry `warm` flag is unrelated and never used for this. */
  lastUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined {
    const last = this.lastTurnRow();
    return last ? { input: last.input, cacheRead: last.cacheRead, cacheWrite: last.cacheWrite } : undefined;
  }

  /** Last recorded request's usage of any kind — turn or warm refresh.
   *  A warm refresh re-reads the whole prefix, so its cached share is the
   *  freshest measurement of the cache's actual warmth; live views sample
   *  this instead of `lastUsage` so idle warming cannot pin the reading
   *  to a stale turn. */
  lastRequestUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined {
    const last = this.sessionRows[this.sessionRows.length - 1];
    return last ? { input: last.input, cacheRead: last.cacheRead, cacheWrite: last.cacheWrite } : undefined;
  }

  /** Milliseconds since the current session's last recorded turn ended. */
  msSinceLastTurn(): number {
    const last = this.lastTurnRow();
    return last ? Date.now() - last.ts : Number.POSITIVE_INFINITY;
  }

  /** Globally-unique id of the current session's last row, if any. */
  lastRowId(): string | undefined {
    return this.lastTurnRow()?.id;
  }

  /** The session's newest real turn (`kind` absent or `"turn"`),
   *  scanning back over any warm-refresh rows appended after it. */
  private lastTurnRow(): UsageRow | undefined {
    for (let i = this.sessionRows.length - 1; i >= 0; i--) {
      if (this.sessionRows[i].kind !== "warm") return this.sessionRows[i];
    }
    return undefined;
  }

  /** Record one confirmed warm refresh as a ledger row of `kind`
   *  `"warm"` so turn-scoped accessors skip it while totals and
   *  /cache-stats still count it. Stamp time is reconcile time, at most
   *  one refresh cadence after the refresh itself landed. */
  recordWarm(usage: Usage | undefined, model: string): UsageRow | undefined {
    return this.append(usage, model, this.sessionId ?? "session", { warm: true }, "warm");
  }

  /** Flush queued appends, then bound the file; call once at shutdown. */
  async close(): Promise<void> {
    await this.flush();
    this.compact();
  }

  /**
   * Locked read-modify-write retention: merge the freshest disk rows,
   * fold evicted rows into the baseline, trim to the window, and persist
   * only when something changed. Returns whether the file was rewritten.
   */
  compact(): boolean {
    return this.enforceRetention();
  }

  /** Resolve once every queued append has landed. */
  flush(): Promise<void> {
    return this.sink.flush();
  }

  /**
   * Reconcile with the file inside the sink's lock: normalize the disk
   * rows, move everything past the window into the disk baseline, and
   * adopt the committed snapshot. The disk snapshot is authoritative for
   * the baseline; the local rows are never merged back in, or rows another
   * process already folded into the baseline would be resurrected.
   */
  private enforceRetention(): boolean {
    const commit = this.sink.transform((snapshot) => {
      const rows = this.normalize(snapshot.rows);
      const split = CacheLedger.splitIndex(rows.length, this.maxRows);
      const baseline = this.addTotals(snapshot.baseline, this.sumRows(rows.slice(0, split)));
      const next: LedgerSnapshot = { baseline, rows: rows.slice(split) };
      return this.snapshotEqual(snapshot, next) ? snapshot : next;
    });
    this.baseline = commit.snapshot.baseline;
    this.rows = commit.snapshot.rows;
    this.sessionRows = this.trimToWindow(this.sessionRows);
    return commit.rewritten;
  }

  /** Keep `seq` ahead of every retained row so new ids stay unique. */
  private noteSeq(): void {
    for (const row of this.rows) if (row.seq >= this.seq) this.seq = row.seq + 1;
  }

  /** Build one ledger row from a recorded usage. `kind` is written last
   *  so the ledger's own classification always wins. */
  private buildRow(
    usage: Usage,
    model: string,
    session: string,
    extras: RecordExtras = {},
    kind: UsageRow["kind"] = "turn",
  ): UsageRow {
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
      kind,
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

  /** Fold global evictions into the baseline; trim the session window. */
  private trim(): boolean {
    const rowsBefore = this.rows.length;
    const sessionBefore = this.sessionRows.length;
    const split = CacheLedger.splitIndex(this.rows.length, this.maxRows);
    if (split > 0) {
      this.baseline = this.addTotals(this.baseline, this.sumRows(this.rows.slice(0, split)));
      this.rows = this.rows.slice(split);
    }
    this.sessionRows = this.trimToWindow(this.sessionRows);
    return this.rows.length !== rowsBefore || this.sessionRows.length !== sessionBefore;
  }

  /**
   * Bound the file during a long session, not only at load/shutdown: after
   * one full window of appends the file holds the window plus those appends,
   * so rewrite it to the retained set. A no-op when unbounded.
   */
  private maybeCompactFile(): void {
    if (!Number.isFinite(this.maxRows)) return;
    this.appendsSinceCompact++;
    if (this.appendsSinceCompact < this.maxRows) return;
    this.appendsSinceCompact = 0;
    this.enforceRetention();
  }

  /** Keep only the newest `maxRows` entries of one collection. */
  private trimToWindow(rows: UsageRow[]): UsageRow[] {
    const split = CacheLedger.splitIndex(rows.length, this.maxRows);
    return split > 0 ? rows.slice(split) : rows;
  }

  /** How many leading rows fall outside a window of `maxRows`. */
  private static splitIndex(length: number, maxRows: number): number {
    return Number.isFinite(maxRows) ? Math.max(0, length - maxRows) : 0;
  }

  /** Whether a candidate snapshot changes nothing (same baseline, same rows). */
  private snapshotEqual(a: LedgerSnapshot, b: LedgerSnapshot): boolean {
    if (!this.totalsEqual(a.baseline, b.baseline)) return false;
    if (a.rows.length !== b.rows.length) return false;
    return a.rows.every((row, index) => row === b.rows[index]);
  }

  private totalsEqual(a: UsageTotals, b: UsageTotals): boolean {
    return a.n === b.n && a.input === b.input && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
  }

  private addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
    return {
      input: a.input + b.input,
      cacheRead: a.cacheRead + b.cacheRead,
      cacheWrite: a.cacheWrite + b.cacheWrite,
      n: a.n + b.n,
    };
  }

  private sumRows(rows: UsageRow[]): UsageTotals {
    return rows.reduce(
      (a, r) => ({
        input: a.input + r.input,
        cacheRead: a.cacheRead + r.cacheRead,
        cacheWrite: a.cacheWrite + r.cacheWrite,
        n: a.n + 1,
      }),
      CacheLedger.zeroTotals(),
    );
  }

  private static zeroTotals(): UsageTotals {
    return { input: 0, cacheRead: 0, cacheWrite: 0, n: 0 };
  }
}
