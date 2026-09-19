/**
 * pi-cache — auto-compaction controller tests.
 * decide() must compact only in a cold window (or churned/rotated
 * prefix) with context above the threshold and cooldowns elapsed; the
 * TTL-gap requirement must be waived for the churn path.
 */

import { test, assert, assertEq } from "./harness.ts";
import { AutocompactController } from "../src/autocompact.ts";

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