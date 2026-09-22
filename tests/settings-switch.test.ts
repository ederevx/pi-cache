/**
 * pi-cache — settings switch board tests.
 * The board owns every option's side effect: flipping the owning
 * controller, persisting to the owned settings file, and returning the
 * notification. Options must stay independent, and the snapshot must
 * report each owner's live value.
 */

import { test, assert, assertEq, scratchDir } from "./harness.ts";
import { SettingsSwitchBoard } from "../src/settings-switch.ts";
import { SettingsPresenter } from "../src/settings.ts";
import { CacheLedger, type RecordSink, type UsageRow } from "../src/ledger.ts";
import { PrefixNormalizer } from "../src/normalizer.ts";
import { BreakpointAnchor } from "../src/breakpoint-anchor.ts";
import { RetentionRewriter } from "../src/retention.ts";
import { SystemCanonicalizer } from "../src/canonicalizer.ts";
import { CacheKeySharer } from "../src/cache-key.ts";
import { WarmingPolicy } from "../src/warming-policy.ts";
import { CompactionAdvisor } from "../src/compaction.ts";
import { AutocompactController } from "../src/autocompact.ts";
import { FastCompactionController } from "../src/fastcompact.ts";
import { UserSettingsStore } from "../src/user-settings.ts";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/** In-memory sink so the ledger needs no files. */
class MemorySink implements RecordSink {
  rows: UsageRow[] = [];
  append(row: UsageRow): void {
    this.rows.push(row);
  }
  load(): UsageRow[] {
    return [...this.rows];
  }
  transform(keep: (rows: UsageRow[]) => UsageRow[]): void {
    const raw = [...this.rows];
    const next = keep(raw);
    if (next !== raw) this.rows = next.map((row) => ({ ...row }));
  }
}

let seq = 0;

function board(pinned: string[] = []) {
  const file = join(scratchDir(), `settings-switch-${seq++}.json`);
  const ledger = new CacheLedger(new MemorySink(), true, 100);
  const normalizer = new PrefixNormalizer({ dedupTools: true });
  const anchor = new BreakpointAnchor();
  const retention = new RetentionRewriter(false);
  const canonicalizer = new SystemCanonicalizer(true);
  const cacheKey = new CacheKeySharer(false);
  const warmingPolicy = new WarmingPolicy(false);
  const advisor = new CompactionAdvisor({ enabled: true });
  const autocompact = new AutocompactController({ enabled: true, cooldownSeconds: 0 });
  const fast = new FastCompactionController({ enabled: true, branchEnabled: true });
  const stats = new SettingsPresenter();
  const store = new UserSettingsStore(file);
  return {
    board: new SettingsSwitchBoard(
      ledger,
      normalizer,
      anchor,
      retention,
      canonicalizer,
      cacheKey,
      warmingPolicy,
      advisor,
      autocompact,
      fast,
      stats,
      store,
      new Set(pinned),
    ),
    ledger,
    normalizer,
    anchor,
    retention,
    canonicalizer,
    cacheKey,
    warmingPolicy,
    advisor,
    autocompact,
    fast,
    stats,
    file,
  };
}

function stored(file: string): Record<string, boolean> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, boolean>;
}

test("settings-switch: toggling telemetry flips the ledger and persists", () => {
  const { board: b, ledger, file } = board();
  const message = b.set("telemetry", "off");
  assert(message !== undefined && message.includes("telemetry off"), "off message");
  assertEq(ledger.enabled, false);
  assertEq(stored(file).telemetry, false);
});

test("settings-switch: dedup flips the normalizer and persists", () => {
  const { board: b, normalizer, file } = board();
  b.set("dedupTools", "off");
  assertEq(normalizer.dedupTools, false);
  assertEq(stored(file).dedupTools, false);
});

test("settings-switch: the five request transforms switch independently", () => {
  const { board: b, anchor, retention, canonicalizer, cacheKey, warmingPolicy, advisor, file } = board();
  b.set("anchor", "off");
  b.set("retentionOverride", "on");
  b.set("canonicalize", "off");
  b.set("sharedKey", "on");
  b.set("forceWarm", "on");
  assertEq(anchor.enabled, false);
  assertEq(retention.enabled, true);
  assertEq(canonicalizer.enabled, false);
  assertEq(cacheKey.enabled, true);
  assertEq(warmingPolicy.enabled, true);
  assertEq(advisor.enabled, true, "advisory untouched");
  assertEq(stored(file).anchor, false);
  assertEq(stored(file).retentionOverride, true);
  assertEq(stored(file).canonicalize, false);
  assertEq(stored(file).sharedKey, true);
  assertEq(stored(file).forceWarm, true);
});

test("settings-switch: miss diagnosis flips the presenter and persists", () => {
  const { board: b, stats, file } = board();
  b.set("missDiagnosis", "off");
  assertEq(stats.missDiagnosisEnabled, false);
  assertEq(stored(file).missDiagnosis, false);
  b.set("missDiagnosis", "on");
  assertEq(stats.missDiagnosisEnabled, true);
  assertEq(stored(file).missDiagnosis, true);
});

test("settings-switch: an env-pinned row is refused and not persisted", () => {
  const { board: b, anchor, file } = board(["anchor"]);
  const message = b.set("anchor", "off");
  assert(message !== undefined && message.includes("pinned"), "pin refusal message");
  assertEq(anchor.enabled, true, "controller untouched");
  assert(!existsSync(file), "nothing persisted for a pinned row");
});

test("settings-switch: advisory switches independently", () => {
  const { board: b, advisor, file } = board();
  b.set("advisory", "off");
  assertEq(advisor.enabled, false);
  assertEq(stored(file).advisory, false);
});

test("settings-switch: auto-compaction flips the controller", () => {
  const { board: b, autocompact, file } = board();
  b.set("autoCompact", "off");
  assertEq(autocompact.enabled, false);
  assertEq(stored(file).autoCompact, false);
});

test("settings-switch: fast compaction leaves auto-compaction alone", () => {
  const { board: b, fast, autocompact, file } = board();
  b.set("fastCompaction", "off");
  assertEq(fast.enabled, false);
  assertEq(autocompact.enabled, true, "auto-compaction untouched");
  assertEq(stored(file).fastCompaction, false);
});

test("settings-switch: branch summary is independent and persisted", () => {
  const { board: b, fast, file } = board();
  b.set("fastBranchSummary", "off");
  assertEq(fast.branchEnabled, false);
  assertEq(fast.enabled, true, "compaction switch untouched");
  assertEq(stored(file).fastBranchSummary, false);
});

test("settings-switch: snapshot reflects every current value", () => {
  const { board: b } = board();
  const before = b.snapshot();
  assertEq(before.telemetry, true);
  assertEq(before.fastBranchSummary, true);
  b.set("dedupTools", "off");
  b.set("fastCompaction", "off");
  const after = b.snapshot();
  assertEq(after.dedupTools, false);
  assertEq(after.fastCompaction, false);
  assertEq(after.telemetry, true, "untouched value still true");
});

test("settings-switch: an unknown id changes nothing", () => {
  const { board: b, fast } = board();
  assertEq(b.set("nope", "on"), undefined);
  assertEq(fast.enabled, true);
  assertEq(fast.branchEnabled, true);
});