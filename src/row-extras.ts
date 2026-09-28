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
   *  (infinite touch age) records neither the age nor warm. Each field is
   *  read independently, so one failing signal drops only its own field. */
  build(ctx: SessionContextView | undefined): RecordExtras {
    const extras: RecordExtras = {};
    const cacheTtlMs = this.read(() => this.signals.cacheTtlMs(ctx));
    if (typeof cacheTtlMs === "number") extras.cacheTtlMs = cacheTtlMs;
    const piTtl = this.read(() => this.signals.piTtlMs(ctx));
    if (typeof piTtl === "number") extras.piTtlMs = piTtl;
    const retentionLong = this.read(() => this.signals.retentionLong());
    if (typeof retentionLong === "boolean") extras.retentionLong = retentionLong;
    const touch = this.read(() => this.signals.msSinceCacheTouch());
    if (typeof touch === "number" && Number.isFinite(touch)) {
      extras.msSinceCacheTouch = touch;
      if (typeof cacheTtlMs === "number") extras.warm = touch < cacheTtlMs;
    }
    return extras;
  }

  /** One signal read, degrading to undefined so telemetry never breaks a
   *  turn and a failure drops only the field that needed the signal. */
  private read<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch {
      return undefined;
    }
  }
}
