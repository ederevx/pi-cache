/**
 * pi-cache — TTL learner tests.
 * Knee estimation from synthetic ledger rows: the sample threshold,
 * hysteresis, per-session gap isolation, and the learner-side floor.
 */

import { test, assert, assertEq } from "./harness.ts";
import { TtlLearner } from "../src/ttl-learner.ts";
import type { UsageRow } from "../src/ledger.ts";

let nextSeq = 0;

function row(overrides: Partial<UsageRow> & { ts: number; cacheRead: number }): UsageRow {
  nextSeq++;
  return {
    id: `r${nextSeq}`,
    seq: nextSeq,
    pid: 1,
    session: "s",
    model: "m",
    input: 5000,
    output: 10,
    cacheWrite: 0,
    totalTokens: 5000,
    ...overrides,
  };
}

const BASE = 10_000_000;

test("learner: no knee below the minimum hit sample count", () => {
  const learner = new TtlLearner({ minHits: 4 });
  learner.note(row({ ts: BASE, cacheRead: 0, cacheWrite: 5000 }));
  learner.note(row({ ts: BASE + 120_000, cacheRead: 5000 }));
  learner.note(row({ ts: BASE + 240_000, cacheRead: 5000 }));
  // Three hit rows, one 120 s gap: below the threshold, nothing published.
  assertEq(learner.estimate("m"), undefined);
  learner.note(row({ ts: BASE + 360_000, cacheRead: 5000 }));
  learner.note(row({ ts: BASE + 480_000, cacheRead: 5000 }));
  assertEq(learner.estimate("m"), 120);
});

test("learner: the knee is the largest idle gap that still hit", () => {
  const learner = new TtlLearner({ minHits: 2 });
  // Hits at 10 s and 80 s gaps, then a full miss after a 200 s gap, then a
  // hit at a 10 s gap. The knee stays at 80 s: misses never raise it.
  learner.note(row({ ts: BASE, cacheRead: 0, cacheWrite: 5000 }));
  learner.note(row({ ts: BASE + 10_000, cacheRead: 5000 }));
  learner.note(row({ ts: BASE + 90_000, cacheRead: 5000 }));
  learner.note(row({ ts: BASE + 290_000, cacheRead: 0, cacheWrite: 5000 }));
  learner.note(row({ ts: BASE + 300_000, cacheRead: 5000 }));
  assertEq(learner.estimate("m"), 80);
});

test("learner: hysteresis keeps the published knee against small wiggle", () => {
  const learner = new TtlLearner({ minHits: 2, hysteresisRatio: 0.2 });
  learner.note(row({ ts: BASE, cacheRead: 0, cacheWrite: 5000 }));
  learner.note(row({ ts: BASE + 120_000, cacheRead: 5000 }));
  learner.note(row({ ts: BASE + 130_000, cacheRead: 5000 }));
  assertEq(learner.estimate("m"), 120);
  // A new hit gap of 132 s is within the 20% band: the knee stays 120.
  learner.note(row({ ts: BASE + 250_000, cacheRead: 5000 }));
  assertEq(learner.estimate("m"), 120);
  // A hit gap of 200 s (>20% drift) re-publishes.
  learner.note(row({ ts: BASE + 450_000, cacheRead: 5000 }));
  assertEq(learner.estimate("m"), 200);
});
test("learner: gaps never cross session boundaries", () => {
  const learner = new TtlLearner({ minHits: 2 });
  learner.note(row({ ts: BASE, cacheRead: 0, cacheWrite: 5000, session: "s1" }));
  // A different session's row one millisecond later must not create a gap.
  learner.note(row({ ts: BASE + 500_000, cacheRead: 5000, session: "s2" }));
  learner.note(row({ ts: BASE + 510_000, cacheRead: 5000, session: "s2" }));
  // The only same-session gap is 10 s -> floored to 60 s.
  assertEq(learner.estimate("m"), 60);
});

test("learner: other models and thin evidence keep the published knee", () => {
  const learner = new TtlLearner({ minHits: 2 });
  learner.note(row({ ts: BASE, cacheRead: 0, cacheWrite: 5000 }));
  learner.note(row({ ts: BASE + 120_000, cacheRead: 5000 }));
  learner.note(row({ ts: BASE + 130_000, cacheRead: 5000 }));
  assertEq(learner.estimate("m"), 120);
  // Rows of another model never affect this estimate.
  learner.note(row({ ts: BASE + 900_000, cacheRead: 5000, model: "other" }));
  assertEq(learner.estimate("m"), 120);
});

test("learner: the published knee never drops below the 60 s floor", () => {
  const learner = new TtlLearner({ minHits: 2 });
  learner.note(row({ ts: BASE, cacheRead: 0, cacheWrite: 5000 }));
  for (let i = 1; i <= 3; i++) {
    learner.note(row({ ts: BASE + i * 5_000, cacheRead: 5000 }));
  }
  assertEq(learner.estimate("m"), 60);
});