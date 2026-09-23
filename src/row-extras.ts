/**
 * pi-cache — per-row cache-state assembly.
 *
 * One responsibility: assemble the optional `RecordExtras` a ledger row
 * carries from the live session signals — the TTL views, the effective
 * retention tier, and the warm state at record time. Each field is
 * computed independently so one failure degrades the row instead of
 * dropping it; telemetry must never break the turn. All fields are
 * optional, so rows written without them stay schema-compatible.
 */

import type { RecordExtras } from "./ledger.ts";
import type { SessionContextView } from "./signals.ts";

/** The signal views the builder reads (narrowed to what it needs). */
export interface RowExtrasSignals {
  /** pi-cache's coldness-ramp TTL view (ms). */
  cacheTtlMs(ctx: SessionContextView | undefined): number;
  /** pi's tier-or-undefined warming view (ms). */
  piTtlMs(ctx: SessionContextView | undefined): number | undefined;
  /** Whether the effective retention is the long tier. */
  retentionLong(): boolean;
  /** Milliseconds since the cache was last touched (turn or warm). */
  msSinceCacheTouch(): number;
}

export class RowExtrasBuilder {
  constructor(private readonly signals: RowExtrasSignals) {}

  /** Build the extras for one assistant row. `warm` is true when the
   *  cache was touched within its effective TTL; an untouched session
   *  (infinite touch age) records neither the age nor warm. */
  build(ctx: SessionContextView | undefined): RecordExtras {
    const extras: RecordExtras = {};
    try {
      extras.cacheTtlMs = this.signals.cacheTtlMs(ctx);
      const piTtl = this.signals.piTtlMs(ctx);
      if (piTtl !== undefined) extras.piTtlMs = piTtl;
      extras.retentionLong = this.signals.retentionLong();
      const touch = this.signals.msSinceCacheTouch();
      if (Number.isFinite(touch)) {
        extras.msSinceCacheTouch = touch;
        extras.warm = touch < extras.cacheTtlMs;
      }
    } catch {
      /* partial extras beat no row */
    }
    return extras;
  }
}
