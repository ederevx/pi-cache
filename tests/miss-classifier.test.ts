/**
 * pi-cache — miss classifier tests.
 * Every category from synthetic ledger rows: cold-start, idle-expiry
 * (against a resolved TTL), replica-flap (confirmed by the following call),
 * partial-miss, plus the floor, counters, dominance, and advisory summary.
 */

import { test, assert, assertEq } from "./harness.ts";
import { MissClassifier } from "../src/miss-classifier.ts";
import type { UsageRow } from "../src/ledger.ts";

let nextSeq = 0;

function row(
  overrides: Partial<UsageRow> & { ts: number; cacheRead: number },
): UsageRow {
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

const BASE = 20_000_000;
const TTL_S = 120;

function classifier() {
  return new MissClassifier({ ttlSecondsOf: () => TTL_S });
}

test("classifier: the first call of a session is a cold start", () => {
  const c = classifier();
  assertEq(c.feed(row({ ts: BASE, cacheRead: 0, cacheWrite: 5000 })), "cold-start");
  assertEq(c.stats().coldStart, 1);
  assertEq(c.dominant(), "cold-start");
});

test("classifier: a gap beyond the resolved TTL is an idle expiry", () => {
  const c = classifier();
  c.useSession("s");
  c.feed(row({ ts: BASE, cacheRead: 5000 }));
  const miss = row({ ts: BASE + 121_000, cacheRead: 0, cacheWrite: 5000 });
  assertEq(c.feed(miss), "idle-expiry");
  assertEq(c.stats().idleExpiry, 1);
});

test("classifier: a gap within the TTL pends for the following call", () => {
  const c = classifier();
  c.useSession("s");
  c.feed(row({ ts: BASE, cacheRead: 5000 }));
  // Full miss right after a hit, small gap: not decidable yet.
  const miss = row({ ts: BASE + 5_000, cacheRead: 0, cacheWrite: 5000 });
  assertEq(c.feed(miss), undefined);
  assertEq(c.stats().fullMisses, 0, "nothing counted until the next call");
  // The following call hits back with cacheRead ≈ the missed input: flap.
  const next = row({ ts: BASE + 6_000, cacheRead: 5000 });
  assertEq(c.feed(next), "replica-flap");
  assertEq(c.stats().replicaFlap, 1);
  assertEq(c.dominant(), "replica-flap");
});

test("classifier: a broken follow-up makes the indeterminate miss 'other'", () => {
  const c = classifier();
  c.feed(row({ ts: BASE, cacheRead: 5000 }));
  c.feed(row({ ts: BASE + 5_000, cacheRead: 0, cacheWrite: 5000 }));
  // The following call also misses: the flap pattern is broken.
  assertEq(c.feed(row({ ts: BASE + 6_000, cacheRead: 0, cacheWrite: 5000 })), "other");
  assertEq(c.stats().other, 1);
  // And this second miss is itself pending now.
  assertEq(c.stats().fullMisses, 1);
});

test("classifier: a >20% cacheRead drop on a hit is a partial miss", () => {
  const c = classifier();
  c.feed(row({ ts: BASE, cacheRead: 1000 }));
  assertEq(c.feed(row({ ts: BASE + 1_000, cacheRead: 700 })), "partial-miss");
  assertEq(c.feed(row({ ts: BASE + 6_000, cacheRead: 950 })), undefined);
  assertEq(c.stats().partialMiss, 1);
});

test("classifier: misses at or below the input floor are ignored", () => {
  const c = classifier();
  c.feed(row({ ts: BASE, cacheRead: 0, cacheWrite: 900, input: 1000 }));
  assertEq(c.stats().fullMisses, 0);
  assertEq(c.summary(), undefined);
});

test("classifier: replica-flap needs the next cacheRead near the input", () => {
  const c = classifier();
  c.feed(row({ ts: BASE, cacheRead: 5000 }));
  c.feed(row({ ts: BASE + 5_000, cacheRead: 0, cacheWrite: 5000 }));
  // The following call hits but with a cacheRead far from the input:
  // not a flap, so the miss is unclassified ('other').
  assertEq(c.feed(row({ ts: BASE + 6_000, cacheRead: 800 })), "other");
  assertEq(c.stats().replicaFlap, 0);
});

test("classifier: counters, dominance and the advisory summary", () => {
  const c = classifier();
  c.feed(row({ ts: BASE, cacheRead: 5000 }));
  c.feed(row({ ts: BASE + 5_000, cacheRead: 0, cacheWrite: 5000 }));
  c.feed(row({ ts: BASE + 6_000, cacheRead: 5000 }));
  c.feed(row({ ts: BASE + 11_000, cacheRead: 0, cacheWrite: 5000 }));
  c.feed(row({ ts: BASE + 141_000, cacheRead: 0, cacheWrite: 5000 }));
  const stats = c.stats();
  assertEq(stats.replicaFlap, 1);
  assertEq(stats.idleExpiry, 1);
  assertEq(stats.other, 1);
  assertEq(stats.fullMisses, 3);
  assertEq(c.dominant(), "replica-flap");
  assert(c.summary()?.startsWith("pi-cache: miss diagnosis — 3 full misses"), c.summary());
  assert(c.summary()?.includes("idle-expiry 1"), c.summary());
  // A clean session has no summary.
  const clean = classifier();
  clean.feed(row({ ts: BASE, cacheRead: 5000 }));
  assertEq(clean.summary(), undefined);
});