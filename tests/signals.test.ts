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
    affinityRotated: () => true,
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
  assertEq(signal.affinityRotated(), true);
  assertEq(signal.cacheTtlMs?.(), 10_000);
  assert(signal.costRates?.() === undefined, "no cost declared");
});