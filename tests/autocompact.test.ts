/**
 * pi-cache — auto-compaction controller tests.
 * decide() must compact only in a cold window (or churned/rotated
 * prefix) with context above the threshold and cooldowns elapsed; the
 * TTL-gap requirement must be waived for the churn path.
 */

import { test, assert, assertEq } from "./harness.ts";
import { AutocompactController } from "../src/autocompact.ts";
import { CompactionPressure } from "../src/pressure.ts";

const opts = { enabled: true, cooldownSeconds: 0, minGapSeconds: 240 };

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
});

test("autocompact: cold but context below threshold blocks", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(50, signals());
  assertEq(verdict.shouldCompact, false);
  assertEq(verdict.reason, "context below threshold");
});

test("autocompact: cold + high context + elapsed gap compacts", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(85, signals({ msSinceLastTurn: () => 600_000 }));
  assertEq(verdict.shouldCompact, true);
  assertEq(verdict.reason, "cold window + context threshold");
});

test("autocompact: cold without an elapsed gap blocks", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(85, signals({ msSinceLastTurn: () => 30_000 }));
  assertEq(verdict.shouldCompact, false);
  assertEq(verdict.reason, "cold without a gap");
});

test("autocompact: churned prefix waives the gap requirement", () => {
  const c = new AutocompactController(opts);
  c.noteTurn(0);
  const verdict = c.decide(
    85,
    signals({ msSinceLastTurn: () => 30_000, headChurn: () => 2 }),
  );
  assertEq(verdict.shouldCompact, true);
  assertEq(verdict.reason, "churned prefix + context threshold");
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
