/**
 * pi-cache — auto-compaction controller tests.
 * decide() must compact only when cache coldness clears the floor (or the
 * prefix churned/rotated) and cooldowns elapsed; the TTL idle ramp raises
 * coldness, and the pressure model owns the probabilistic context gate.
 */

import { test, assert, assertEq } from "./harness.ts";
import { AutocompactController } from "../src/autocompact.ts";
import { CompactionPressure } from "../src/pressure.ts";

const opts = { enabled: true, cooldownSeconds: 0 };

function signals(overrides: Partial<ReturnType<typeof baseSignals>> = {}) {
  return { ...baseSignals(), ...overrides };
}
function baseSignals() {
  return {
    lastUsage: () => ({ input: 1000, cacheRead: 0, cacheWrite: 0 }),
    msSinceLastTurn: () => 300_000,
    headChurn: () => 0,
    affinityRotated: () => false,
  };
}

test("autocompact: disabled never compacts", () => {
  const c = new AutocompactController({ ...opts, enabled: false });
  assertEq(c.decide(90, signals()).shouldCompact, false);
});

test("autocompact: no usage yet blocks", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(90, signals({ lastUsage: () => undefined }));
  assertEq(verdict.shouldCompact, false);
  assertEq(verdict.reason, "no usage yet");
});

test("autocompact: warm cache blocks", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(90, signals({ lastUsage: () => ({ input: 100, cacheRead: 900, cacheWrite: 0 }) }));
  assertEq(verdict.shouldCompact, false);
  assertEq(verdict.reason, "cache warm");
  assertEq(verdict.coldness, 0, "a majority-hit request is coldness 0");
});

test("autocompact: cold but context below threshold blocks", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(50, signals());
  assertEq(verdict.shouldCompact, false);
  assertEq(verdict.reason, "context below threshold");
  assertEq(verdict.coldness, 1, "a ~0% hit request is coldness 1");
});

test("autocompact: cold + high context compacts", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(85, signals());
  assertEq(verdict.shouldCompact, true);
  assertEq(verdict.reason, "cold window + context threshold");
});

test("autocompact: the TTL idle ramp raises coldness", () => {
  const warm = () => ({ input: 100, cacheRead: 900, cacheWrite: 0 });
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  // 10% of a 300 s TTL is below the 0.2 floor: still warm.
  const early = c.decide(
    85,
    signals({ lastUsage: warm, msSinceLastTurn: () => 30_000, cacheTtlMs: () => 300_000 }),
  );
  assertEq(early.shouldCompact, false, "warm before the ramp clears the floor");
  assert(early.coldness !== undefined && early.coldness < 0.2, "coldness below floor");
  // 40% of the TTL clears the floor and the fixed percent threshold.
  const later = c.decide(
    85,
    signals({ lastUsage: warm, msSinceLastTurn: () => 120_000, cacheTtlMs: () => 300_000 }),
  );
  assertEq(later.shouldCompact, true, "time makes a warm cache compactable");
  assert(later.coldness !== undefined && later.coldness >= 0.2, "coldness cleared the floor");
});

test("autocompact: churned prefix is cold", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(85, signals({ headChurn: () => 2 }));
  assertEq(verdict.shouldCompact, true);
  assertEq(verdict.reason, "churned prefix + context threshold");
  assertEq(verdict.coldness, 1);
});

test("autocompact: rotation also triggers the churn path", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(85, signals({ affinityRotated: () => true }));
  assertEq(verdict.shouldCompact, true);
});

test("autocompact: cooldown turns gate repeated compaction", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  assertEq(c.decide(85, signals()).shouldCompact, true, "first compaction fires");
  c.markCompacted();
  c.noteTurn(1);
  const blocked = c.decide(85, signals());
  assertEq(blocked.shouldCompact, false, "inside turn cooldown");
  assertEq(blocked.reason, "cooldown");
  c.noteTurn(6);
  assertEq(c.decide(85, signals()).shouldCompact, true, "cooldown turns elapsed");
});

test("autocompact: pressure draw fires at high tokens", () => {
  const pressure = new CompactionPressure({ random: () => 0 });
  const c = new AutocompactController({ ...opts, cacheNeutral: true, pressure });
  c.noteTurn(0);
  const verdict = c.decide({ tokens: 180_000, contextWindow: 200_000, percent: 90 }, signals());
  assertEq(verdict.shouldCompact, true);
  assertEq(verdict.reason, "compaction pressure");
  assert(verdict.probability === 1, "saturated pressure probability");
});

test("autocompact: pressure does not fire below the minimum context", () => {
  const costRates = () => ({ input: 0.8, cacheRead: 0.2, cacheWrite: 0 });
  const pressure = new CompactionPressure({ random: () => 0 });
  const c = new AutocompactController({ ...opts, cacheNeutral: true, pressure, minTokens: 50_000 });
  c.noteTurn(0);
  const tiny = c.decide({ tokens: 470, contextWindow: 1_048_576, percent: 0.045 }, signals({ costRates }));
  assertEq(tiny.shouldCompact, false);
  assertEq(tiny.reason, "context below minimum");
  const grown = c.decide({ tokens: 200_000, contextWindow: 1_048_576, percent: 19 }, signals({ costRates }));
  assertEq(grown.shouldCompact, true, "above the floor the cold pressure still fires");
});

test("autocompact: a non-positive minimum context disables the floor", () => {
  const costRates = () => ({ input: 0.8, cacheRead: 0.2, cacheWrite: 0 });
  const pressure = new CompactionPressure({ random: () => 0 });
  const c = new AutocompactController({ ...opts, cacheNeutral: true, pressure, minTokens: 0 });
  c.noteTurn(0);
  const verdict = c.decide({ tokens: 470, contextWindow: 1_048_576, percent: 0.045 }, signals({ costRates }));
  assertEq(verdict.shouldCompact, true);
});

test("autocompact: pressure draw can decline below the ramp", () => {
  const pressure = new CompactionPressure({ random: () => 0.999999 });
  const c = new AutocompactController({ ...opts, cacheNeutral: true, pressure });
  c.noteTurn(0);
  const verdict = c.decide({ tokens: 120_000, contextWindow: 200_000, percent: 60 }, signals());
  assertEq(verdict.shouldCompact, false);
  assertEq(verdict.reason, "pressure below draw");
});

test("autocompact: cache-neutral fast compaction relaxes the warm gate", () => {
  const warm = signals({ lastUsage: () => ({ input: 100, cacheRead: 900, cacheWrite: 0 }) });
  const plain = new AutocompactController(opts);
  plain.noteTurn(0);
  assertEq(plain.decide(90, warm).shouldCompact, false, "warm block without fast compaction");
  const neutral = new AutocompactController({ ...opts, cacheNeutral: true });
  neutral.noteTurn(0);
  assertEq(neutral.decide(90, warm).shouldCompact, true, "warm allowed when cache-neutral");
});

test("autocompact: currentPressure previews the live sample", () => {
  const pressure = new CompactionPressure({ random: () => 0.5 });
  const c = new AutocompactController({ ...opts, pressure });
  const verdict = c.currentPressure(
    { tokens: 180_000, contextWindow: 200_000, percent: 90 },
    { input: 1000, cacheRead: 0, cacheWrite: 0 },
  );
  assert(verdict !== undefined, "verdict expected");
  assert(verdict!.pressure > 0.9, "cold pressure exceeds utilization");
  assertEq(
    c.currentPressure({ tokens: null, contextWindow: 1 }, { input: 1, cacheRead: 0, cacheWrite: 0 }),
    undefined,
    "null tokens cannot be sampled",
  );
  assertEq(
    c.currentPressure(undefined, { input: 1, cacheRead: 0, cacheWrite: 0 }),
    undefined,
    "missing window cannot be sampled",
  );
  assertEq(c.currentPressure({ tokens: 1, contextWindow: 2 }, undefined), undefined, "no usage");
});

test("autocompact: fast compaction triggers on warm token pressure", () => {
  const pressure = new CompactionPressure({ random: () => 0 });
  const c = new AutocompactController({ ...opts, cacheNeutral: true, pressure });
  c.noteTurn(0);
  const warm = signals({ lastUsage: () => ({ input: 100, cacheRead: 900, cacheWrite: 0 }) });
  const verdict = c.decide({ tokens: 180_000, contextWindow: 200_000, percent: 90 }, warm);
  assertEq(verdict.shouldCompact, true);
  assertEq(verdict.reason, "compaction pressure");
  assert(verdict.probability === 1, "neutral pressure saturates");
});