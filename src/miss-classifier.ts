/**
 * pi-cache — cache miss classifier.
 *
 * One responsibility: classify observed misses so advisories and stats can
 * say which miss type dominates. A full miss (cacheRead == 0 with input
 * above a floor) is one of: cold-start (first call of the session),
 * idle-expiry (gap since the previous call exceeded the resolved TTL), or
 * replica-flap (a stochastic provider-side blip: the previous call hit and
 * the following call hits with cacheRead near this call's input). A hit
 * whose cacheRead dropped >20% against the previous call is a partial miss.
 * Categories needing the following call stay pending until it arrives; the
 * counts are the classifier's own state, mutated only here.
 */

import type { UsageRow } from "./ledger.ts";

export type MissCategory = "cold-start" | "idle-expiry" | "replica-flap" | "partial-miss";

/** The dominance pick, including the residual full-miss bucket. */
export type MissDominant = MissCategory | "other";

export interface MissStats {
  coldStart: number;
  idleExpiry: number;
  replicaFlap: number;
  partialMiss: number;
  /** Full misses matching none of the three named patterns. */
  other: number;
  /** Full misses observed above the input floor (all four buckets). */
  fullMisses: number;
}

export interface MissClassifierOptions {
  /** Resolved provider cache TTL (s) for a row's model; the resolver binds this. */
  ttlSecondsOf: (model: string) => number;
  /** Full misses at or below this input size are ignored (sub-minimum
   *  prefixes never cache anyway). */
  minMissInputTokens?: number;
  /** Relative tolerance for the flap's `next.cacheRead ≈ input` test. */
  flapToleranceRatio?: number;
  /** Relative cacheRead drop (vs the previous call) that is a partial miss. */
  partialDropRatio?: number;
  /** Retained rows of the active session (oldest dropped). */
  maxRows?: number;
}

export class MissClassifier {
  private static readonly DEFAULT_MIN_MISS_INPUT = 1024;
  private static readonly DEFAULT_FLAP_TOLERANCE = 0.25;
  private static readonly DEFAULT_PARTIAL_DROP = 0.2;
  private static readonly DEFAULT_MAX_ROWS = 128;

  private sessionId: string | undefined;
  private rows: UsageRow[] = [];
  /** A full miss awaiting the following call (replica-flap or other). */
  private pending: UsageRow | undefined;
  private readonly counts = {
    coldStart: 0,
    idleExpiry: 0,
    replicaFlap: 0,
    partialMiss: 0,
    other: 0,
  };

  constructor(private readonly opts: MissClassifierOptions) {}

  /** Adopt a session id and reset its window and counters. */
  useSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.rows = [];
    this.pending = undefined;
    this.resetCounts();
  }

  /**
   * Feed one recorded row; returns the category decided by this feed — the
   * pending row finalized by it, else the row's own immediately-decidable
   * category, else undefined (e.g. a full miss still awaiting its next).
   */
  feed(row: UsageRow): MissCategory | undefined {
    if (!row || (this.sessionId !== undefined && row.session !== this.sessionId)) {
      return undefined;
    }
    const finalized = this.finalizePending(row);
    const immediate = this.classifyNow(row);
    this.pushRow(row);
    return finalized ?? immediate;
  }

  /** The current miss counters (all zeroed per session via useSession). */
  stats(): MissStats {
    const fullMisses =
      this.counts.coldStart +
      this.counts.idleExpiry +
      this.counts.replicaFlap +
      this.counts.other;
    return { ...this.counts, fullMisses };
  }

  /** The category with the most observations, or undefined when none. */
  dominant(): MissDominant | undefined {
    const entries: Array<[MissDominant, number]> = [
      ["replica-flap", this.counts.replicaFlap],
      ["idle-expiry", this.counts.idleExpiry],
      ["cold-start", this.counts.coldStart],
      ["partial-miss", this.counts.partialMiss],
      ["other", this.counts.other],
    ];
    let best: [MissDominant, number] | undefined;
    for (const entry of entries) {
      if (entry[1] > 0 && (best === undefined || entry[1] > best[1])) best = entry;
    }
    return best?.[0];
  }

  /** One advisory line naming every observed miss type, or undefined. */
  summary(): string | undefined {
    const stats = this.stats();
    if (stats.fullMisses === 0 && stats.partialMiss === 0) return undefined;
    const full: string[] = [];
    if (stats.replicaFlap > 0) full.push(`replica-flap ${stats.replicaFlap}`);
    if (stats.idleExpiry > 0) full.push(`idle-expiry ${stats.idleExpiry}`);
    if (stats.coldStart > 0) full.push(`cold-start ${stats.coldStart}`);
    if (stats.other > 0) full.push(`other ${stats.other}`);
    const parts: string[] = [];
    if (stats.fullMisses > 0) {
      parts.push(`${stats.fullMisses} full misses (${full.join(", ")})`);
    }
    if (stats.partialMiss > 0) parts.push(`${stats.partialMiss} partial`);
    return `pi-cache: miss diagnosis — ${parts.join(", ")}`;
  }

  /** Classify what is decidable without the following call; an
   *  indeterminate full miss stays pending until its next call arrives. */
  private classifyNow(row: UsageRow): MissCategory | undefined {
    const prev = this.prevRow(row);
    if (row.cacheRead === 0) {
      if (row.input < this.minMissInputTokens()) return undefined;
      if (prev === undefined) {
        this.counts.coldStart++;
        return "cold-start";
      }
      if (row.ts - prev.ts > this.ttlSecondsOf(row.model) * 1000) {
        this.counts.idleExpiry++;
        return "idle-expiry";
      }
      this.pending = row;
      return undefined;
    }
    if (
      prev !== undefined &&
      prev.cacheRead > 0 &&
      row.cacheRead < prev.cacheRead * (1 - this.partialDropRatio())
    ) {
      this.counts.partialMiss++;
      return "partial-miss";
    }
    return undefined;
  }

  /** Finalize the pending full miss using `next` as the following call. */
  private finalizePending(next: UsageRow): MissCategory | undefined {
    const pending = this.pending;
    if (pending === undefined) return undefined;
    this.pending = undefined;
    const prev = this.prevPending(pending);
    if (this.isReplicaFlap(pending, prev, next)) {
      this.counts.replicaFlap++;
      return "replica-flap";
    }
    this.counts.other++;
    return "other";
  }

  /** Stochastic replica flap: the previous call hit and the following call
   *  hit back with cacheRead near this call's input within tolerance. */
  private isReplicaFlap(
    row: UsageRow,
    prev: UsageRow | undefined,
    next: UsageRow | undefined,
  ): boolean {
    if (prev === undefined || next === undefined) return false;
    if (prev.cacheRead <= 0 || next.cacheRead <= 0) return false;
    const slack = this.flapToleranceRatio() * Math.max(row.input, 1);
    return Math.abs(next.cacheRead - row.input) <= slack;
  }

  /** The row before `pending` inside the active-session window. */
  private prevPending(pending: UsageRow): UsageRow | undefined {
    const index = this.rows.lastIndexOf(pending);
    return index > 0 ? this.rows[index - 1] : undefined;
  }

  /** The newest retained row (the fed row's previous call). */
  private prevRow(row: UsageRow): UsageRow | undefined {
    const index = this.rows.lastIndexOf(row);
    if (index > 0) return this.rows[index - 1];
    // `row` is not pushed yet: the newest retained row is its previous call.
    return this.rows[this.rows.length - 1];
  }

  private pushRow(row: UsageRow): void {
    this.rows.push(row);
    const max = this.maxRows();
    if (this.rows.length > max) this.rows = this.rows.slice(this.rows.length - max);
  }

  private resetCounts(): void {
    this.counts.coldStart = 0;
    this.counts.idleExpiry = 0;
    this.counts.replicaFlap = 0;
    this.counts.partialMiss = 0;
    this.counts.other = 0;
  }

  private minMissInputTokens(): number {
    return this.opts.minMissInputTokens ?? MissClassifier.DEFAULT_MIN_MISS_INPUT;
  }

  private flapToleranceRatio(): number {
    return this.opts.flapToleranceRatio ?? MissClassifier.DEFAULT_FLAP_TOLERANCE;
  }

  private partialDropRatio(): number {
    return this.opts.partialDropRatio ?? MissClassifier.DEFAULT_PARTIAL_DROP;
  }

  private maxRows(): number {
    return this.opts.maxRows ?? MissClassifier.DEFAULT_MAX_ROWS;
  }

  private ttlSecondsOf(model: string): number {
    return this.opts.ttlSecondsOf(model);
  }
}