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

const THEME: ViewTheme = { fg: (_color, text) => text };

const LIVE: LiveSettings = {
  telemetry: true,
  sortTools: false,
  dedupTools: true,
  pinSession: true,
  advisory: false,
  autoCompact: true,
  fastCompaction: true,
  fastBranchSummary: false,
};

test("settings: rows keep the option order and every row carries a value", () => {
  const rows = new SettingsPresenter().rows(LIVE);
  assertEq(rows.length, 8, "row count");
  assertEq(
    rows.map((r) => r.id).join(","),
    "telemetry,sortTools,dedupTools,pinSession,advisory,autoCompact,fastCompaction,fastBranchSummary",
  );
  assertEq(rows[1].value, "off", "stored option reflected");
  assertEq(rows[6].value, "on", "live compaction switch reflected");
  assertEq(rows[7].value, "off", "live branch switch reflected");
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