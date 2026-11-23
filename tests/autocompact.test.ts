/**
 * pi-cache — auto-compaction controller tests.
 * decide() must compact only when cache coldness clears the floor (or the
 * prefix churned) and cooldowns elapsed; the TTL idle ramp raises
 * coldness, and the pressure model owns the probabilistic context gate.
 */

import { test, assert, assertEq } from "./harness.ts";
import { AutocompactController } from "../src/autocompact.ts";
import { CompactionPressure } from "../src/pressure.ts";
import { ContextDegradation } from "../src/context-degradation.ts";

const opts = { enabled: true, cooldownSeconds: 0 };

function signals(overrides: Partial<ReturnType<typeof baseSignals>> = {}) {
  return { ...baseSignals(), ...overrides };
}
function baseSignals() {
  return {
    lastUsage: () => ({ input: 1000, cacheRead: 0, cacheWrite: 0 }),
    msSinceLastTurn: () => 300_000,
    /** Absent by default so the idle ramp falls back to the last turn. */
    msSinceCacheTouch: undefined as (() => number) | undefined,
    /** Absent by default so the freshest request falls back to the turn. */
    lastRequestUsage: undefined as
      | (() => { input: number; cacheRead: number; cacheWrite: number } | undefined)
      | undefined,
    /** Absent by default: no active context age, so no time component. */
    contextActiveMs: undefined as (() => number | undefined) | undefined,
    headChurn: () => 0,
  };
}

test("autocompact: the enable, usage, warmth and context gates open in order", () => {
  const gates: Array<{
    label: string;
    enabled?: boolean;
    signals: ReturnType<typeof signals>;
    percent: number;
    compact: boolean;
    reason?: string;
    coldness?: number;
  }> = [
    { label: "disabled never compacts", enabled: false, signals: signals(), percent: 90, compact: false },
    {
      label: "no usage yet blocks",
      signals: signals({ lastUsage: () => undefined }),
      percent: 90,
      compact: false,
      reason: "no usage yet",
    },
    {
      label: "warm cache blocks",
      signals: signals({ lastUsage: () => ({ input: 100, cacheRead: 900, cacheWrite: 0 }) }),
      percent: 90,
      compact: false,
      reason: "cache warm",
      coldness: 0,
    },
    {
      label: "cold but context below threshold blocks",
      signals: signals(),
      percent: 50,
      compact: false,
      reason: "context below threshold",
      coldness: 1,
    },
    {
      label: "cold + high context compacts",
      signals: signals(),
      percent: 85,
      compact: true,
      reason: "cold window + context threshold",
    },
  ];
  for (const gate of gates) {
    const c = new AutocompactController({ ...opts, enabled: gate.enabled ?? true });
    c.noteTurn();
    const verdict = c.decide(gate.percent, gate.signals);
    assertEq(verdict.shouldCompact, gate.compact, gate.label);
    if (gate.reason !== undefined) assertEq(verdict.reason, gate.reason, `${gate.label}: reason`);
    if (gate.coldness !== undefined) {
      assertEq(verdict.coldness, gate.coldness, `${gate.label}: coldness`);
    }
  }
});

test("autocompact: the TTL idle ramp raises coldness", () => {
  const warm = () => ({ input: 100, cacheRead: 900, cacheWrite: 0 });
  const c = new AutocompactController(opts);
  c.noteTurn();
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

test("autocompact: the cache-touch ramp uses the most recent warm", () => {
  const warm = () => ({ input: 100, cacheRead: 900, cacheWrite: 0 });
  const c = new AutocompactController(opts);
  c.noteTurn();
  // A warm cache whose last turn was long ago but which pi warmed recently
  // must not be treated as cold by the idle ramp.
  const recent = c.decide(
    85,
    signals({ lastUsage: warm, msSinceCacheTouch: () => 1000, cacheTtlMs: () => 300_000 }),
  );
  assertEq(recent.shouldCompact, false, "a recent warm keeps the cache warm");
  const expired = c.decide(
    85,
    signals({ lastUsage: warm, msSinceCacheTouch: () => 300_000, cacheTtlMs: () => 300_000 }),
  );
  assertEq(expired.shouldCompact, true, "an expired cache touch makes it compactable");
});

test("autocompact: churned prefix is cold", () => {
  const c = new AutocompactController(opts);
  c.noteTurn();
  const verdict = c.decide(85, signals({ headChurn: () => 2 }));
  assertEq(verdict.shouldCompact, true);
  assertEq(verdict.reason, "churned prefix + context threshold");
  assertEq(verdict.coldness, 1);
});

test("autocompact: cooldown counts session turns across runs", () => {
  const c = new AutocompactController(opts);
  c.noteTurn();
  assertEq(c.decide(85, signals()).shouldCompact, true, "first compaction fires");
  c.markCompacted();
  c.noteTurn();
  const blocked = c.decide(85, signals());
  assertEq(blocked.shouldCompact, false, "inside turn cooldown");
  assertEq(blocked.reason, "cooldown");
  // The cooldown counts session turns, so it elapses after five more turns
  // regardless of how pi indexes turns within a run.
  for (let i = 0; i < 5; i++) c.noteTurn();
  assertEq(c.decide(85, signals()).shouldCompact, true, "cooldown turns elapsed");
});

test("autocompact: pressure draw fires at high tokens", () => {
  const pressure = new CompactionPressure({ random: () => 0 });
  const c = new AutocompactController({ ...opts, cacheNeutral: true, pressure });
  c.noteTurn();
  const verdict = c.decide({ tokens: 180_000, contextWindow: 200_000, percent: 90 }, signals());
  assertEq(verdict.shouldCompact, true);
  assertEq(verdict.reason, "compaction pressure");
  assert(verdict.probability === 1, "saturated pressure probability");
});

test("autocompact: the minimum-context floor gates the pressure draw", () => {
  const costRates = () => ({ input: 0.8, cacheRead: 0.2, cacheWrite: 0 });
  const pressure = new CompactionPressure({ random: () => 0 });
  const rows: Array<[string, number, number, number, boolean, string?]> = [
    ["a tiny context below the floor never compacts", 50_000, 470, 0.045, false, "context below minimum"],
    ["above the floor the cold pressure still fires", 50_000, 200_000, 19, true],
    ["a non-positive floor is disabled", 0, 470, 0.045, true],
  ];
  for (const [label, minTokens, tokens, percent, compact, reason] of rows) {
    const c = new AutocompactController({ ...opts, cacheNeutral: true, pressure, minTokens });
    c.noteTurn();
    const verdict = c.decide({ tokens, contextWindow: 1_048_576, percent }, signals({ costRates }));
    assertEq(verdict.shouldCompact, compact, label);
    if (reason !== undefined) assertEq(verdict.reason, reason, `${label}: reason`);
  }
});

test("autocompact: pressure draw can decline below the ramp", () => {
  const pressure = new CompactionPressure({ random: () => 0.999999 });
  const c = new AutocompactController({ ...opts, cacheNeutral: true, pressure });
  c.noteTurn();
  const verdict = c.decide({ tokens: 120_000, contextWindow: 200_000, percent: 60 }, signals());
  assertEq(verdict.shouldCompact, false);
  assertEq(verdict.reason, "pressure below draw");
});

test("autocompact: cache-neutral fast compaction relaxes the warm gate", () => {
  const warm = signals({ lastUsage: () => ({ input: 100, cacheRead: 900, cacheWrite: 0 }) });
  const plain = new AutocompactController(opts);
  plain.noteTurn();
  assertEq(plain.decide(90, warm).shouldCompact, false, "warm block without fast compaction");
  const neutral = new AutocompactController({ ...opts, cacheNeutral: true });
  neutral.noteTurn();
  assertEq(neutral.decide(90, warm).shouldCompact, true, "warm allowed when cache-neutral");
});

test("autocompact: currentPressure previews the live sample", () => {
  let draws = 0;
  const pressure = new CompactionPressure({
    random: () => {
      draws++;
      return 0.5;
    },
  });
  const c = new AutocompactController({ ...opts, pressure });
  const verdict = c.currentPressure(
    { tokens: 180_000, contextWindow: 200_000, percent: 90 },
    { input: 1000, cacheRead: 0, cacheWrite: 0 },
  );
  assert(verdict !== undefined, "verdict expected");
  assert(verdict!.pressure > 0.9, "cold pressure exceeds utilization");
  assertEq(draws, 0, "the live preview consumes no RNG draw");
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
  c.noteTurn();
  const warm = signals({ lastUsage: () => ({ input: 100, cacheRead: 900, cacheWrite: 0 }) });
  const verdict = c.decide({ tokens: 180_000, contextWindow: 200_000, percent: 90 }, warm);
  assertEq(verdict.shouldCompact, true);
  assertEq(verdict.reason, "compaction pressure");
  assert(verdict.probability === 1, "neutral pressure saturates");
});

test("autocompact: midterm needs a saturated pressure at a half-full window", () => {
  let draws = 0;
  const costRates = () => ({ input: 0.8, cacheRead: 0.2, cacheWrite: 0 });
  const pressure = new CompactionPressure({
    random: () => {
      draws++;
      return 0.99;
    },
  });
  const c = new AutocompactController({ ...opts, cacheNeutral: true, pressure, midterm: true });
  c.noteTurn();
  // Cold economics at the degradation onset saturate the pressure, so the
  // midterm predicate holds even though the draw would decline it.
  assertEq(
    c.midtermEligible({ tokens: 100_000, contextWindow: 200_000, percent: 50 }, signals({ costRates })),
    true,
    "half full + saturated pressure is eligible",
  );
  assertEq(
    c.midtermEligible({ tokens: 20_000, contextWindow: 200_000, percent: 10 }, signals({ costRates })),
    false,
    "below the 32K research floor onset is never eligible",
  );
  assertEq(
    c.midtermEligible({ tokens: 100_000, contextWindow: 200_000, percent: 50 }, signals()),
    false,
    "without cost rates the pressure never saturates",
  );
  assertEq(draws, 0, "the predicate reads the probability, never an RNG draw");
  const off = new AutocompactController({ ...opts, cacheNeutral: true, pressure, midterm: false });
  off.noteTurn();
  assertEq(
    off.midtermEligible({ tokens: 100_000, contextWindow: 200_000, percent: 50 }, signals({ costRates })),
    false,
    "the midterm switch gates the predicate",
  );
});

test("autocompact: decide reads the freshest request, not just the last turn", () => {
  const c = new AutocompactController(opts);
  c.noteTurn();
  // The last real turn missed (cold), but a warm refresh landed after it.
  const s = signals({
    lastUsage: () => ({ input: 1000, cacheRead: 0, cacheWrite: 0 }),
    lastRequestUsage: () => ({ input: 100, cacheRead: 900, cacheWrite: 0 }),
  });
  const verdict = c.decide(90, s);
  assertEq(verdict.shouldCompact, false);
  assertEq(verdict.reason, "cache warm");
});

test("autocompact: midterm fires past the degradation onset below the percent gate", () => {
  const model = new CompactionPressure({
    degradation: new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1 }),
    random: () => 0,
  });
  const c = new AutocompactController({ ...opts, midterm: true, pressure: model });
  c.noteTurn();
  // 43% of a 1M window is under the 50% gate but past the band's 125K onset
  // (an eighth of the window), and four active hours raise the plateau close
  // to 1 there.
  const aged = signals({ contextActiveMs: () => 4 * 60 * 60 * 1000 });
  assertEq(c.midtermEligible({ tokens: 450_000, contextWindow: 1_000_000 }, aged), true);
  // Without the age the band's 0.433 alone cannot saturate the ramp.
  assertEq(c.midtermEligible({ tokens: 450_000, contextWindow: 1_000_000 }, signals()), false);
  // Below the onset the percent gate cannot be satisfied either.
  assertEq(c.midtermEligible({ tokens: 60_000, contextWindow: 1_000_000 }, aged), false);

  // 15% clears a 10% configured gate but the degradation ramp has not started,
  // so the probability is 0 and the midterm trigger stays off.
  const rampOnly = new CompactionPressure({
    degradation: new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1, floor: 0 }),
    random: () => 0,
  });
  const low = new AutocompactController({
    ...opts,
    midterm: true,
    midtermMinPercent: 10,
    pressure: rampOnly,
  });
  low.noteTurn();
  assertEq(low.midtermEligible({ tokens: 150_000, contextWindow: 1_000_000 }, signals()), false);
});

test("autocompact: the active context age reaches the pressure sample", () => {
  const model = new CompactionPressure({
    degradation: new ContextDegradation({ start: 0.5, full: 0.85, gamma: 1 }),
    random: () => 0,
  });
  const c = new AutocompactController({ ...opts, midterm: true, pressure: model });
  c.noteTurn();
  const aged = signals({ contextActiveMs: () => 60 * 60 * 1000 });
  // 0.5 * 0.75 = 0.375 after one half-life at half the window's band.
  assertEq(
    c.currentPressure({ tokens: 500_000, contextWindow: 1_000_000 }, baseSignals().lastUsage(), aged)
      ?.degradation,
    0.75,
  );
});