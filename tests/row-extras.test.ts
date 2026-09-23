/**
 * pi-cache — row-extras builder tests.
 * RowExtrasBuilder must assemble the optional per-row cache state from
 * the session signals, degrade field-by-field when a signal throws, and
 * draw the warm boundary strictly below the effective TTL.
 */

import { test, assert, assertEq } from "./harness.ts";
import { RowExtrasBuilder, type RowExtrasSignals } from "../src/row-extras.ts";
import type { SessionContextView } from "../src/signals.ts";

const ctx = undefined as SessionContextView | undefined;

function signals(overrides: Partial<RowExtrasSignals> = {}): RowExtrasSignals {
  return {
    cacheTtlMs: () => 300_000,
    piTtlMs: () => 300_000,
    retentionLong: () => false,
    msSinceCacheTouch: () => 30_000,
    ...overrides,
  };
}

test("row-extras: assembles every field from the signals", () => {
  const rowExtras = new RowExtrasBuilder(signals());
  const extras = rowExtras.build(ctx);
  assertEq(extras.cacheTtlMs, 300_000);
  assertEq(extras.piTtlMs, 300_000);
  assertEq(extras.retentionLong, false);
  assertEq(extras.msSinceCacheTouch, 30_000);
  assertEq(extras.warm, true, "touch within TTL is warm");
});

test("row-extras: warm boundary is strictly below the TTL", () => {
  const at = new RowExtrasBuilder(signals({ msSinceCacheTouch: () => 300_000 }));
  assertEq(at.build(ctx).warm, false, "touch exactly at TTL is not warm");
  const over = new RowExtrasBuilder(signals({ msSinceCacheTouch: () => 300_001 }));
  assertEq(over.build(ctx).warm, false, "touch past TTL is not warm");
  const just = new RowExtrasBuilder(signals({ msSinceCacheTouch: () => 299_999 }));
  assertEq(just.build(ctx).warm, true, "touch just under TTL is warm");
});

test("row-extras: untouched sessions omit the touch fields", () => {
  const rowExtras = new RowExtrasBuilder(
    signals({ msSinceCacheTouch: () => Number.POSITIVE_INFINITY }),
  );
  const extras = rowExtras.build(ctx);
  assertEq(extras.msSinceCacheTouch, undefined, "no touch age");
  assertEq(extras.warm, undefined, "no warm verdict");
  assertEq(extras.cacheTtlMs, 300_000, "TTL views still recorded");
});

test("row-extras: absent pi tier is omitted, not zeroed", () => {
  const rowExtras = new RowExtrasBuilder(signals({ piTtlMs: () => undefined }));
  const extras = rowExtras.build(ctx);
  assertEq(extras.piTtlMs, undefined, "piTtlMs absent");
  assertEq(extras.cacheTtlMs, 300_000, "fallback TTL still recorded");
});

test("row-extras: one failing signal degrades only its own field", () => {
  const rowExtras = new RowExtrasBuilder(
    signals({
      piTtlMs: () => {
        throw new Error("signal failure");
      },
    }),
  );
  const extras = rowExtras.build(ctx);
  assertEq(extras.piTtlMs, undefined, "failed field omitted");
  assertEq(extras.cacheTtlMs, 300_000, "healthy fields survive");
  assertEq(extras.warm, true, "warm still computed");
});
