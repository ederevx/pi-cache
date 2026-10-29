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
  midterm: true,
  fastCompaction: true,
  fastBranchSummary: false,
  fastDigest: true,
};

test("settings: rows keep the option order and every row carries a value", () => {
  const rows = new SettingsPresenter().rows(LIVE);
  assertEq(rows.length, 14, "row count");
  assertEq(
    rows.map((r) => r.id).join(","),
    "telemetry,dedupTools,anchor,retentionOverride,canonicalize,sharedKey,forceWarm,missDiagnosis,advisory,autoCompact,midterm,fastCompaction,fastDigest,fastBranchSummary",
  );
  assertEq(rows[1].value, "off", "stored option reflected");
  assertEq(rows[7].value, "on", "live miss-diagnosis switch reflected");
  assertEq(rows[10].value, "on", "live midterm switch reflected");
  assertEq(rows[11].value, "on", "live compaction switch reflected");
  assertEq(rows[12].value, "on", "live digest switch reflected");
  assertEq(rows[13].value, "off", "live branch switch reflected");
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
  assertEq(bare.length, 14, "no action row without a callback");
  const rows = new SettingsPresenter().rows(LIVE, new Set(), () => "done");
  assertEq(rows.length, 15, "action row appended");
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
  })[14];
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
test("settings: a failed presentation reports why above the listing", async () => {
  const notices: Array<{ message: string; kind?: string }> = [];
  const ui = {
    custom: async () => {
      throw new Error("no dock here");
    },
    notify: (message: string, kind?: string) => notices.push({ message, kind }),
  };
  await new SettingsPresenter().present(LIVE, ui as never, "tui", () => {});
  assertEq(notices.length, 1, "one notice, not a silent fallback");
  assertEq(notices[0].kind, "error");
  assert(notices[0].message.includes("no dock here"), "the reason is carried");
  assert(notices[0].message.includes("Fast compaction"), "the listing still answers");
});

test("settings: a successful presentation reports nothing", async () => {
  const notices: string[] = [];
  const ui = {
    custom: async (
      factory: (tui: unknown, theme: ViewTheme, kb: unknown, done: () => void) => unknown,
    ): Promise<void> => {
      factory({}, THEME, {}, () => {});
    },
    notify: (message: string) => notices.push(message),
  };
  await new SettingsPresenter().present(LIVE, ui as never, "tui", () => {});
  assertEq(notices.length, 0, "no notice on the success path");
});

test("settings: a row that throws on input is reported and the dock survives", async () => {
  // A row whose submenu cannot be built (the shape a pi component throws
  // when its theme is missing) must be reported, not escape into pi's
  // input loop.
  const notices: string[] = [];
  let view:
    | { handleInput(data: string): void; render(w: number): string[]; selectItem(id: string): void }
    | undefined;
  const ui = {
    custom: async (
      factory: (tui: unknown, theme: ViewTheme, kb: unknown, done: () => void) => {
        handleInput(data: string): void;
        render(w: number): string[];
        selectItem(id: string): void;
      },
    ): Promise<void> => {
      view = factory({}, THEME, {}, () => {});
    },
    notify: (message: string) => notices.push(message),
  };
  const presenter = new SettingsPresenter();
  const rows = presenter.rows(LIVE, new Set(), () => "done");
  const action = rows[rows.length - 1];
  action.submenu = () => {
    throw new Error("Theme not initialized. Call initTheme() first.");
  };
  presenter.rows = () => rows;
  await presenter.present(LIVE, ui as never, "tui", () => {});
  assert(view !== undefined, "the dock mounted");
  view!.selectItem("restoreDefaults");
  view!.handleInput("\r");
  assert(notices.length >= 1, "the build failure is reported, not thrown");
  assert(notices[0].includes("Theme not initialized"), "the original reason is carried");
  assertEq(view!.render(80).length > 0, true, "the dock keeps rendering");
  // A later keypress still works rather than ending the dock.
  view!.handleInput("\u001b[B");
});
