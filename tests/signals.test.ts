/**
 * pi-cache — live session signals tests.
 * SessionSignals must read model cost rates, provider cache TTL, and the
 * session id from the handler context, and expose the injected collaborator
 * reads as the autocompaction signal set.
 */

import { test, assert, assertEq } from "./harness.ts";
import { SessionSignals, type SignalSources } from "../src/signals.ts";

function sources(overrides: Partial<SignalSources> = {}): SignalSources {
  return {
    lastUsage: () => ({ input: 10, cacheRead: 90, cacheWrite: 0 }),
    msSinceLastTurn: () => 1234,
    headChurn: () => 2,
    ...overrides,
  };
}

const opts = { cacheRetentionLong: false, fallbackTtlSeconds: 300 };

test("signals: model cost rates are read when present", () => {
  const s = new SessionSignals(opts, sources());
  const rates = s.costRates({ model: { cost: { input: 0.8, cacheRead: 0.2 } } });
  assertEq(rates?.input, 0.8);
  assertEq(rates?.cacheRead, 0.2);
  assertEq(rates?.cacheWrite, 0, "missing write rate defaults to 0");
  assertEq(s.costRates({ model: {} }), undefined, "absent rates");
  assertEq(s.costRates(undefined), undefined, "no model");
});

test("signals: cache TTL prefers the model tier over the fallback", () => {
  const s = new SessionSignals(opts, sources());
  assertEq(s.cacheTtlMs({ model: { promptCache: { short: 60, long: 3600 } } }), 60_000);
  const long = new SessionSignals({ ...opts, cacheRetentionLong: true }, sources());
  assertEq(long.cacheTtlMs({ model: { promptCache: { short: 60, long: 3600 } } }), 3_600_000);
  assertEq(s.cacheTtlMs(undefined), 300_000, "fallback when the model declares none");
});

test("signals: session id falls back safely", () => {
  const s = new SessionSignals(opts, sources());
  assertEq(s.sessionIdOf({ sessionManager: { getSessionId: () => "s1" } }), "s1");
  assertEq(s.sessionIdOf(undefined), "session");
  assertEq(
    s.sessionIdOf({
      sessionManager: {
        getSessionId: () => {
          throw new Error("accessor failed");
        },
      },
    }),
    "session",
    "a throwing accessor falls back",
  );
});

test("signals: the signal set reads the injected collaborator seam", () => {
  const s = new SessionSignals(opts, sources());
  const signal = s.for({ model: { promptCache: { short: 10 } } });
  assertEq(signal.lastUsage()?.cacheRead, 90);
  assertEq(signal.msSinceLastTurn(), 1234);
  assertEq(signal.headChurn(), 2);
  assertEq(signal.cacheTtlMs?.(), 10_000);
  assert(signal.costRates?.() === undefined, "no cost declared");
});
test("signals: the cache touch uses the most recent warm", () => {
  const warmed = new SessionSignals(opts, sources({ msSinceLastWarm: () => 1000 }));
  assertEq(warmed.msSinceCacheTouch(), 1000, "a warm refresh is more recent than the turn");
  assertEq(warmed.for(undefined).msSinceCacheTouch?.(), 1000, "exposed on the signal set");
  const unwarmed = new SessionSignals(opts, sources());
  assertEq(unwarmed.msSinceCacheTouch(), 1234, "falls back to the last turn");
});

test("signals: piTtlMs stays undefined where pi's warmer schedules nothing", () => {
  const s = new SessionSignals(opts, sources());
  assertEq(s.piTtlMs({ model: { promptCache: { short: 60, long: 3600 } } }), 60_000);
  const long = new SessionSignals({ ...opts, cacheRetentionLong: true }, sources());
  assertEq(long.piTtlMs({ model: { promptCache: { short: 60, long: 3600 } } }), 3_600_000);
  // No model tier: pi treats the lifetime as unknown (no warming), so the
  // pi-native view is undefined even though the coldness ramp falls back.
  assertEq(s.piTtlMs(undefined), undefined, "no tier, no pi schedule");
  assertEq(s.piTtlMs({ model: {} }), undefined, "empty model, no pi schedule");
  const override = new SessionSignals(
    { ...opts, retentionLongOf: () => true },
    sources(),
  );
  assertEq(
    override.piTtlMs({ model: { promptCache: { short: 60, long: 3600 } } }),
    3_600_000,
    "the per-request tier rewrite moves the pi view too",
  );
});

test("signals: the resolver-backed fallback precedes the static fallback", () => {
  const resolved = new SessionSignals(
    {
      cacheRetentionLong: false,
      fallbackTtlSeconds: 300,
      fallbackTtlSecondsOf: (ctx) =>
        ctx?.model?.provider === "z-ai" ? 120 : undefined,
    },
    sources(),
  );
  assertEq(resolved.cacheTtlMs({ model: { provider: "z-ai" } }), 120_000);
  assertEq(resolved.cacheTtlMs({ model: {} }), 300_000, "no resolution keeps the fallback");
  // The model tier still wins over the resolver.
  assertEq(
    resolved.cacheTtlMs({ model: { provider: "z-ai", promptCache: { short: 60 } } }),
    60_000,
  );
});
