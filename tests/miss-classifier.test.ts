/**
 * pi-cache — miss classifier tests (revived from the v0.8.0 removal).
 * The taxonomy classifies full misses as cold-start, idle-expiry, or
 * replica-flap, hits with a >20% cacheRead drop as partial, and binds
 * the unified TTL view in milliseconds.
 */

import { test, assertEq } from "./harness.ts";
import { MissClassifier } from "../src/miss-classifier.ts";
import type { UsageRow } from "../src/ledger.ts";

const TTL_MS = 300_000;

function classifier(ttlMs = TTL_MS): MissClassifier {
  return new MissClassifier({ ttlMsOf: () => ttlMs });
}

function row(overrides: Partial<UsageRow>): UsageRow {
  return {
    id: "1:1:1",
    seq: 1,
    ts: 1_000_000,
    pid: 1,
    session: "s",
    model: "m",
    input: 2000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2000,
    ...overrides,
  };
}

test("miss: a first above-floor full miss is a cold start", () => {
  const c = classifier();
  c.useSession("s");
  assertEq(c.feed(row({})), "cold-start");
  assertEq(c.stats().coldStart, 1);
});

test("miss: a full miss after the effective TTL is an idle expiry", () => {
  const c = classifier();
  c.useSession("s");
  c.feed(row({ seq: 1, ts: 1_000_000, cacheRead: 900 }));
  assertEq(c.feed(row({ seq: 2, ts: 1_000_000 + TTL_MS + 1 })), "idle-expiry");
  assertEq(c.stats().idleExpiry, 1);
});

test("miss: a full miss inside the TTL stays pending for the next call", () => {
  const c = classifier();
  c.useSession("s");
  c.feed(row({ seq: 1, ts: 1_000_000, cacheRead: 900 }));
  assertEq(c.feed(row({ seq: 2, ts: 1_000_000 + 1000 })), undefined, "pending");
  // The following call hits back near the missed call's input: flap.
  assertEq(c.feed(row({ seq: 3, ts: 1_000_000 + 2000, cacheRead: 1900 })), "replica-flap");
  assertEq(c.stats().replicaFlap, 1);
});

test("miss: a pending miss whose next call also misses is other", () => {
  const c = classifier();
  c.useSession("s");
  c.feed(row({ seq: 1, ts: 1_000_000, cacheRead: 900 }));
  c.feed(row({ seq: 2, ts: 1_000_000 + 1000 }));
  assertEq(c.feed(row({ seq: 3, ts: 1_000_000 + 2000 })), "other");
  assertEq(c.stats().other, 1);
});

test("miss: a hit with a >20% cacheRead drop is a partial miss", () => {
  const c = classifier();
  c.useSession("s");
  c.feed(row({ seq: 1, ts: 1_000_000, cacheRead: 1000 }));
  assertEq(c.feed(row({ seq: 2, ts: 1_000_000 + 1000, cacheRead: 700 })), "partial-miss");
  assertEq(c.stats().partialMiss, 1);
});

test("miss: below-floor full misses and foreign sessions are ignored", () => {
  const c = classifier();
  c.useSession("s");
  assertEq(c.feed(row({ input: 512 })), undefined, "sub-minimum");
  assertEq(c.feed(row({ session: "other", input: 2000 })), undefined, "foreign");
  const stats = c.stats();
  assertEq(stats.coldStart, 0);
  assertEq(stats.fullMisses, 0);
});

test("miss: stats carry the aggregate and reset per session", () => {
  const c = classifier();
  c.useSession("s");
  c.feed(row({ seq: 1 }));
  const stats = c.stats();
  assertEq(stats.fullMisses, 1);
  c.useSession("s2");
  assertEq(c.stats().fullMisses, 0, "reset on session adoption");
});
