/**
 * pi-cache — fast-switch board tests.
 * The board owns the two switch side effects: flipping the controller flag,
 * persisting to the owned settings file, and returning the notification.
 * The branch switch must not disturb the compaction switch.
 */

import { test, assert, assertEq, scratchDir } from "./harness.ts";
import { FastSwitchBoard } from "../src/fast-switch.ts";
import { FastCompactionController } from "../src/fastcompact.ts";
import { AutocompactController } from "../src/autocompact.ts";
import { UserSettingsStore } from "../src/user-settings.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";

let seq = 0;

function board() {
  const file = join(scratchDir(), `fast-switch-${seq++}.json`);
  const fast = new FastCompactionController({ enabled: true, branchEnabled: true });
  const autocompact = new AutocompactController({ enabled: false, cooldownSeconds: 0 });
  const store = new UserSettingsStore(file);
  return { board: new FastSwitchBoard(fast, autocompact, store), fast, file };
}

test("fast-switch: setting compaction off flips the controller and persists", () => {
  const { board: b, fast, file } = board();
  const message = b.set("fastCompaction", "off");
  assert(message !== undefined && message.includes("off"), "off message");
  assertEq(fast.enabled, false);
  assertEq((JSON.parse(readFileSync(file, "utf8")) as { fastCompaction?: boolean }).fastCompaction, false);
});

test("fast-switch: setting compaction on flips it back", () => {
  const { board: b, fast } = board();
  b.set("fastCompaction", "off");
  const message = b.set("fastCompaction", "on");
  assert(message !== undefined && message.includes("on"), "on message");
  assertEq(fast.enabled, true);
});

test("fast-switch: setting branch summary is independent and persisted", () => {
  const { board: b, fast, file } = board();
  b.set("fastBranchSummary", "off");
  assertEq(fast.branchEnabled, false);
  assertEq(fast.enabled, true, "compaction switch untouched");
  assertEq(
    (JSON.parse(readFileSync(file, "utf8")) as { fastBranchSummary?: boolean }).fastBranchSummary,
    false,
  );
});

test("fast-switch: an unknown id changes nothing", () => {
  const { board: b, fast } = board();
  assertEq(b.set("nope", "on"), undefined);
  assertEq(fast.enabled, true);
  assertEq(fast.branchEnabled, true);
});