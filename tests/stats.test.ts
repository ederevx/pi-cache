/**
 * pi-cache — /cache-stats presenter tests.
 * The two rendered lines must keep global and session scopes distinct, use
 * the no-usage wording for empty scopes, and put the live session signals
 * (compaction pressure, churn, affinity, compaction counts) on the session
 * line only.
 */

import { test, assert } from "./harness.ts";
import { CacheStatsPresenter } from "../src/stats.ts";

const presenter = new CacheStatsPresenter();

test("stats: renders distinct global and session usage lines", () => {
  const text = presenter.render({
    global: { n: 12, input: 1000, cacheRead: 3000, cacheWrite: 500 },
    session: { n: 2, input: 100, cacheRead: 900, cacheWrite: 50 },
    churn: 0,
    affinity: "affinity stable",
    compactions: 1,
    fastCompactions: 1,
    fastEnabled: true,
  });
  const [globalLine, sessionLine] = text.split("\n");
  assert(globalLine.startsWith("pi-cache global: 12 req"), globalLine);
  assert(globalLine.includes("(75.0%)"), globalLine);
  assert(sessionLine.startsWith("pi-cache session: 2 req"), sessionLine);
  assert(sessionLine.includes("(90.0%)"), sessionLine);
});

test("stats: empty scopes render the no-usage wording", () => {
  const text = presenter.render({
    global: { n: 0, input: 0, cacheRead: 0, cacheWrite: 0 },
    session: { n: 0, input: 0, cacheRead: 0, cacheWrite: 0 },
    churn: 0,
    affinity: "affinity n/a",
    compactions: 0,
    fastCompactions: 0,
    fastEnabled: false,
  });
  assert(text.includes("pi-cache global: no usage recorded yet"));
  assert(text.includes("pi-cache session: no usage recorded yet"));
});

test("stats: session line carries pressure, churn and compaction counts", () => {
  const text = presenter.render({
    global: { n: 1, input: 100, cacheRead: 900, cacheWrite: 0 },
    session: { n: 1, input: 100, cacheRead: 900, cacheWrite: 0 },
    churn: 3,
    affinity: "affinity stable",
    compactions: 2,
    fastCompactions: 1,
    fastEnabled: true,
    pressure: { pressure: 0.85, probability: 0.4 },
  });
  assert(text.includes("pressure 0.85 (p 40%)"), text);
  assert(text.includes("head churn 3"), text);
  assert(text.includes("compactions 2 (fast 1, fast on)"), text);
});