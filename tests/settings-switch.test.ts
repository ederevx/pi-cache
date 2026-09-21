/**
 * pi-cache — settings switch board tests.
 * The board owns every option's side effect: flipping the owning
 * controller, persisting to the owned settings file, and returning the
 * notification. Options must stay independent, and the snapshot must
 * report each owner's live value.
 */

import { test, assert, assertEq, scratchDir } from "./harness.ts";
import { SettingsSwitchBoard } from "../src/settings-switch.ts";
import { CacheLedger, type RecordSink, type UsageRow } from "../src/ledger.ts";
import { PrefixNormalizer } from "../src/normalizer.ts";
import { SessionPinner } from "../src/session-pin.ts";
import { CompactionAdvisor } from "../src/compaction.ts";
import { AutocompactController } from "../src/autocompact.ts";
import { FastCompactionController } from "../src/fastcompact.ts";
import { UserSettingsStore } from "../src/user-settings.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";

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

function board() {
  const file = join(scratchDir(), `settings-switch-${seq++}.json`);
  const ledger = new CacheLedger(new MemorySink(), true, 100);
  const normalizer = new PrefixNormalizer({ sortTools: true, dedupTools: true });
  const pinner = new SessionPinner(true);
  const advisor = new CompactionAdvisor({ enabled: true });
  const autocompact = new AutocompactController({ enabled: true, cooldownSeconds: 0 });
  const fast = new FastCompactionController({ enabled: true, branchEnabled: true });
  const store = new UserSettingsStore(file);
  return {
    board: new SettingsSwitchBoard(ledger, normalizer, pinner, advisor, autocompact, fast, store),
    ledger,
    normalizer,
    pinner,
    advisor,
    autocompact,
    fast,
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

test("settings-switch: sort and dedup flip the normalizer independently", () => {
  const { board: b, normalizer, file } = board();
  b.set("sortTools", "off");
  assertEq(normalizer.sortTools, false);
  assertEq(normalizer.dedupTools, true, "dedup untouched");
  b.set("dedupTools", "off");
  assertEq(normalizer.dedupTools, false);
  assertEq(stored(file).sortTools, false);
  assertEq(stored(file).dedupTools, false);
});

test("settings-switch: session pin and advisory switch independently", () => {
  const { board: b, pinner, advisor, file } = board();
  b.set("pinSession", "off");
  assertEq(pinner.enabled, false);
  assertEq(advisor.enabled, true, "advisory untouched");
  b.set("advisory", "off");
  assertEq(advisor.enabled, false);
  assertEq(stored(file).pinSession, false);
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
  b.set("sortTools", "off");
  b.set("fastCompaction", "off");
  const after = b.snapshot();
  assertEq(after.sortTools, false);
  assertEq(after.fastCompaction, false);
  assertEq(after.dedupTools, true, "untouched value still true");
});

test("settings-switch: an unknown id changes nothing", () => {
  const { board: b, fast } = board();
  assertEq(b.set("nope", "on"), undefined);
  assertEq(fast.enabled, true);
  assertEq(fast.branchEnabled, true);
});