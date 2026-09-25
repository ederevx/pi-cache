/**
 * pi-cache — settings presenter tests.
 *
 * The presenter owns the ordered two-column rows and the TUI-vs-fallback
 * routing; the view only renders them. Pin the row order, that every row
 * carries an on/off value the view makes editable, and that the TUI path
 * builds the custom view while other modes fall back to the stderr listing.
 */

import { test, assert, assertEq } from "./harness.ts";
import { SettingsPresenter, type LiveSettings, type ViewTheme } from "../src/settings.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";

const THEME: ViewTheme = { fg: (_color, text) => text };

const LIVE: LiveSettings = {
  telemetry: true,
  dedupTools: false,
  anchor: true,
  retentionOverride: false,
  canonicalize: true,
  sharedKey: false,
  forceWarm: false,
  missDiagnosis: true,
  advisory: false,
  autoCompact: true,
  fastCompaction: true,
  fastBranchSummary: false,
  fastDigest: true,
};

test("settings: rows keep the option order and every row carries a value", () => {
  const rows = new SettingsPresenter().rows(LIVE);
  assertEq(rows.length, 13, "row count");
  assertEq(
    rows.map((r) => r.id).join(","),
    "telemetry,dedupTools,anchor,retentionOverride,canonicalize,sharedKey,forceWarm,missDiagnosis,advisory,autoCompact,fastCompaction,fastDigest,fastBranchSummary",
  );
  assertEq(rows[1].value, "off", "stored option reflected");
  assertEq(rows[7].value, "on", "live miss-diagnosis switch reflected");
  assertEq(rows[10].value, "on", "live compaction switch reflected");
  assertEq(rows[11].value, "on", "live digest switch reflected");
  assertEq(rows[12].value, "off", "live branch switch reflected");
});

test("settings: non-tui modes print the listing and never open the view", async () => {
  let printed = "";
  const original = console.error;
  console.error = (line?: unknown) => {
    printed += String(line);
  };
  try {
    await new SettingsPresenter().present(
      LIVE,
      { custom: () => Promise.reject(new Error("must not render")) },
      "print",
      () => {
        throw new Error("no change expected");
      },
    );
  } finally {
    console.error = original;
  }
  assert(printed.includes("Fast compaction"), "listing names the rows");
  assert(printed.includes("current: on"), "listing shows values");
});

test("settings: the restore action row appears only with a callback", () => {
  const bare = new SettingsPresenter().rows(LIVE);
  assertEq(bare.length, 13, "no action row without a callback");
  const rows = new SettingsPresenter().rows(LIVE, new Set(), () => "done");
  assertEq(rows.length, 14, "action row appended");
  const action = rows[rows.length - 1];
  assertEq(action.id, "restoreDefaults");
  assertEq(action.title, "Restore default configuration");
  assertEq(action.value, "");
  assert(action.submenu !== undefined, "action row opens a submenu");
});

test("settings: confirming restore defaults runs the reset callback once", () => {
  // The selector renders through pi's global theme; initialize it.
  initTheme("dark", false);
  let calls = 0;
  let closed = false;
  const action = new SettingsPresenter().rows(LIVE, new Set(), () => {
    calls++;
    return "pi-cache: restored";
  })[13];
  const component = action.submenu!("", () => {
    closed = true;
  });
  component.handleInput("\n");
  assertEq(calls, 1, "reset invoked");
  assertEq(closed, true, "submenu closed after the choice");
});

test("settings: the fallback listing includes the restore action row", async () => {
  let printed = "";
  const original = console.error;
  console.error = (line?: unknown) => {
    printed += String(line);
  };
  try {
    await new SettingsPresenter().present(
      LIVE,
      undefined,
      "print",
      () => {},
      new Set(),
      () => "done",
    );
  } finally {
    console.error = original;
  }
  assert(printed.includes("Restore default configuration"), "listing names the action row");
});

test("settings: tui mode renders the two-column view through the custom UI", async () => {
  let rendered = "";
  const ui = {
    custom: async (
      factory: (tui: unknown, theme: ViewTheme, kb: unknown, done: () => void) => {
        render(w: number): string[];
      },
    ): Promise<void> => {
      rendered = factory({}, THEME, {}, () => {}).render(80).join("\n");
    },
  };
  await new SettingsPresenter().present(LIVE, ui as never, "tui", () => {});
  assert(rendered.includes("Fast compaction"), "renders the switch row");
  assert(rendered.includes("Telemetry"), "renders the option rows");
  assert(rendered.includes("on"), "renders a current value");
});