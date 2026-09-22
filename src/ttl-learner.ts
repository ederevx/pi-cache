/**
 * pi-cache — empirical cache TTL learner.
 *
 * One responsibility: estimate the empirical TTL "knee" per model from the
 * usage ledger rows — the largest idle gap between consecutive calls of one
 * session that still hit (cacheRead > 0). Gaps are only compared inside one
 * session id so interleaved sessions never fabricate an idle window, a
 * minimum number of hit samples is required before anything is published,
 * and hysteresis keeps a published knee stable against small wiggle. The
 * floor is clamped here; the resolver clamps the ceiling to its static
 * profile, so the learner never raises a provider TTL above its documented
 * default.
 */

import type { UsageRow } from "./ledger.ts";

export interface TtlLearnerOptions {
  /** Hit rows required for one model before a knee is published. */
  minHits?: number;
  /** Relative drift required to re-publish a knee (fraction). */
  hysteresisRatio?: number;
  /** Retained rows per model key (oldest dropped). */
  maxRows?: number;
  /** Lower bound on any published knee (s). */
  floorSeconds?: number;
}

interface KeyState {
  rows: UsageRow[];
  published: number | undefined;
}

export class TtlLearner {
  private static readonly DEFAULT_MIN_HITS = 4;
  private static readonly DEFAULT_HYSTERESIS_RATIO = 0.2;
  private static readonly DEFAULT_MAX_ROWS = 512;
  private static readonly DEFAULT_FLOOR_SECONDS = 60;

  private readonly keys = new Map<string, KeyState>();

  constructor(private readonly opts: TtlLearnerOptions = {}) {}

  /** Feed one recorded ledger row (rows arrive in record order). */
  note(row: UsageRow): void {
    if (!row || typeof row.ts !== "number" || typeof row.model !== "string") return;
    const state = this.stateOf(row.model);
    state.rows.push(row);
    this.trim(state);
  }

  /**
   * The published knee for a model (s), or undefined until the sample
   * threshold is met. Re-evaluated from the window on each call; the
   * published value is kept when evidence is thin or the raw knee only
   * wiggled inside the hysteresis band.
   */
  estimate(model: string): number | undefined {
    const state = this.keys.get(model);
    if (!state) return undefined;
    const knee = this.boundedKnee(state.rows);
    const hits = this.hitCount(state.rows);
    if (knee === undefined || hits < this.minHits()) return state.published;
    if (
      state.published === undefined ||
      Math.abs(knee - state.published) > this.hysteresisRatio() * state.published
    ) {
      state.published = knee;
    }
    return state.published;
  }

  /** The per-model published knee (test/telemetry helper). */
  published(model: string): number | undefined {
    return this.keys.get(model)?.published;
  }

  /** Largest gap (s) between consecutive same-session rows where the later
   *  row still hit; undefined without any such gap. */
  private rawKnee(rows: UsageRow[]): number | undefined {
    let knee: number | undefined;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const row = rows[i];
      if (prev.session !== row.session) continue;
      if (row.cacheRead <= 0) continue;
      const gap = (row.ts - prev.ts) / 1000;
      if (!Number.isFinite(gap) || gap <= 0) continue;
      if (knee === undefined || gap > knee) knee = gap;
    }
    return knee;
  }

  /** Clamp the raw knee to the learner's floor before it is published. */
  private boundedKnee(rows: UsageRow[]): number | undefined {
    const knee = this.rawKnee(rows);
    return knee === undefined ? undefined : Math.max(knee, this.floorSeconds());
  }

  private hitCount(rows: UsageRow[]): number {
    return rows.reduce((n, row) => (row.cacheRead > 0 ? n + 1 : n), 0);
  }

  private stateOf(model: string): KeyState {
    let state = this.keys.get(model);
    if (!state) {
      state = { rows: [], published: undefined };
      this.keys.set(model, state);
    }
    return state;
  }

  private trim(state: KeyState): void {
    const max = this.maxRows();
    if (state.rows.length > max) state.rows = state.rows.slice(state.rows.length - max);
  }

  private minHits(): number {
    return this.opts.minHits ?? TtlLearner.DEFAULT_MIN_HITS;
  }

  private hysteresisRatio(): number {
    return this.opts.hysteresisRatio ?? TtlLearner.DEFAULT_HYSTERESIS_RATIO;
  }

  private maxRows(): number {
    return this.opts.maxRows ?? TtlLearner.DEFAULT_MAX_ROWS;
  }

  private floorSeconds(): number {
    return this.opts.floorSeconds ?? TtlLearner.DEFAULT_FLOOR_SECONDS;
  }
}