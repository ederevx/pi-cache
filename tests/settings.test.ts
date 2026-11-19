/**
 * pi-cache — settings tests.
 * The presenter owns the ordered two-column rows and the TUI-vs-fallback
 * routing; the switch board owns every option's side effect — flipping
 * the owning controller, persisting to the owned settings file, and
 * returning the notification. Options stay independent, and the snapshot
 * reports each owner's live value.
 */

import { test, assert, assertDeepEq, assertEq, scratchDir } from "./harness.ts";
import { SettingsPresenter, type LiveSettings, type ViewTheme } from "../src/settings.ts";
import { SettingsSwitchBoard } from "../src/settings-switch.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  CacheLedger,
  type LedgerSnapshot,
  type RecordSink,
  type SinkCommit,
  type UsageRow,
  type UsageTotals,
} from "../src/ledger.ts";
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
import { existsSync, readFileSync, statSync } from "node:fs";

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

/** In-memory sink so the ledger needs no files. */
class MemorySink implements RecordSink {
  baseline: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, n: 0 };
  rows: UsageRow[] = [];
  append(row: UsageRow): boolean {
    this.rows.push(row);
    return true;
  }
  load(): LedgerSnapshot {
    return { baseline: { ...this.baseline }, rows: [...this.rows] };
  }
  transform(keep: (snapshot: LedgerSnapshot) => LedgerSnapshot): SinkCommit {
    const raw = this.load();
    const next = keep(raw);
    if (next === raw) return { snapshot: raw, rewritten: false };
    this.baseline = { ...next.baseline };
    this.rows = next.rows.map((row) => ({ ...row }));
    return { snapshot: { baseline: { ...this.baseline }, rows: [...this.rows] }, rewritten: true };
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
  const autocompact = new AutocompactController({ enabled: true, cooldownSeconds: 0, midterm: true });
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

/** Every switch a board row owns, read back from its controller. */
function owners(fixture: ReturnType<typeof board>): Record<string, boolean> {
  return {
    telemetry: fixture.ledger.enabled,
    dedupTools: fixture.normalizer.dedupTools,
    anchor: fixture.anchor.enabled,
    retentionOverride: fixture.retention.enabled,
    canonicalize: fixture.canonicalizer.enabled,
    sharedKey: fixture.cacheKey.enabled,
    forceWarm: fixture.warmingPolicy.enabled,
    missDiagnosis: fixture.stats.missDiagnosisEnabled,
    advisory: fixture.advisor.enabled,
    autoCompact: fixture.autocompact.enabled,
    fastCompaction: fixture.fast.enabled,
    fastBranchSummary: fixture.fast.branchEnabled,
  };
}

function stored(file: string): Record<string, boolean> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, boolean>;
}

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

test("settings: flipping one option moves only its owner and persists it", () => {
  type OptionId = keyof ReturnType<typeof owners>;
  const rows: Array<[OptionId, "on" | "off"]> = [
    ["telemetry", "off"],
    ["dedupTools", "off"],
    ["anchor", "off"],
    ["retentionOverride", "on"],
    ["canonicalize", "off"],
    ["sharedKey", "on"],
    ["forceWarm", "on"],
    ["missDiagnosis", "off"],
    ["advisory", "off"],
    ["autoCompact", "off"],
    ["fastCompaction", "off"],
    ["fastBranchSummary", "off"],
  ];
  const defaults = owners(board());
  for (const [id, value] of rows) {
    const fixture = board();
    const message = fixture.board.set(id, value);
    assertDeepEq(owners(fixture), { ...defaults, [id]: value === "on" }, `${id} flips its owner`);
    assertDeepEq(stored(fixture.file), { [id]: value === "on" }, `${id} persists its choice`);
    assert(message !== undefined && message.endsWith("(saved)"), `${id} reports the change`);
  }

  // Several choices share one file, a flip back on reaches its owner, and
  // the message names the change it made.
  const { board: b, stats, file } = board();
  const message = b.set("telemetry", "off");
  assert(message !== undefined && message.includes("telemetry off"), "the message names the change");
  b.set("anchor", "off");
  b.set("missDiagnosis", "off");
  b.set("missDiagnosis", "on");
  assertEq(stats.missDiagnosisEnabled, true, "a flip back on reaches the presenter");
  assertDeepEq(
    stored(file),
    { telemetry: false, anchor: false, missDiagnosis: true },
    "one file keeps every choice",
  );
});

test("settings: an env-pinned row is refused and not persisted", () => {
  const { board: b, anchor, file } = board(["anchor"]);
  const message = b.set("anchor", "off");
  assert(message !== undefined && message.includes("pinned"), "pin refusal message");
  assertEq(anchor.enabled, true, "controller untouched");
  assert(!existsSync(file), "nothing persisted for a pinned row");
});

test("settings: snapshot reflects every current value", () => {
  const { board: b } = board();
  const before = b.snapshot();
  assertEq(before.telemetry, true);
  assertEq(before.fastBranchSummary, true);
  assertEq(before.midterm, true);
  b.set("dedupTools", "off");
  b.set("fastCompaction", "off");
  const after = b.snapshot();
  assertEq(after.dedupTools, false);
  assertEq(after.fastCompaction, false);
  assertEq(after.telemetry, true, "untouched value still true");
});

test("settings: an unknown id changes nothing", () => {
  const { board: b, fast } = board();
  assertEq(b.set("nope", "on"), undefined);
  assertEq(fast.enabled, true);
  assertEq(fast.branchEnabled, true);
});

test("settings: store.reset clears the file and load returns empty", () => {
  const file = join(scratchDir(), `settings-reset-${seq++}.json`);
  const store = new UserSettingsStore(file);
  store.saveFlag("telemetry", false);
  assertEq(stored(file).telemetry, false, "override persisted");
  const mode = statSync(file).mode & 0o777;
  store.reset();
  assertEq(readFileSync(file, "utf8").trim(), "{}", "empty document written");
  assertDeepEq(store.load(), {}, "load falls back to built-in defaults");
  assertEq(statSync(file).mode & 0o777, mode, "file mode preserved");
});

test("settings: restoreDefaults returns every option to its default", () => {
  const {
    board: b,
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
  } = board();
  b.set("telemetry", "off");
  b.set("dedupTools", "off");
  b.set("anchor", "off");
  b.set("retentionOverride", "on");
  b.set("canonicalize", "off");
  b.set("sharedKey", "on");
  b.set("forceWarm", "on");
  b.set("missDiagnosis", "off");
  b.set("advisory", "off");
  b.set("autoCompact", "off");
  b.set("midterm", "off");
  b.set("fastCompaction", "off");
  b.set("fastDigest", "off");
  b.set("fastBranchSummary", "off");
  const message = b.restoreDefaults();
  assert(message.includes("restored default configuration"), message);
  assert(message.includes("stored overrides cleared"), message);
  assertEq(ledger.enabled, true);
  assertEq(normalizer.dedupTools, true);
  assertEq(anchor.enabled, true);
  assertEq(retention.enabled, false);
  assertEq(canonicalizer.enabled, true);
  assertEq(cacheKey.enabled, false);
  assertEq(warmingPolicy.enabled, false);
  assertEq(stats.missDiagnosisEnabled, true);
  assertEq(advisor.enabled, true);
  assertEq(autocompact.enabled, true);
  assertEq(autocompact.midtermEnabled, true);
  assertEq(fast.enabled, true);
  assertEq(fast.digestEnabled, true);
  assertEq(fast.branchEnabled, true);
  assertEq(Object.keys(stored(file)).length, 0, "stored overrides cleared");
});

test("settings: restoreDefaults skips env-pinned rows and reports them", () => {
  const { board: b, retention, file } = board(["retentionOverride"]);
  retention.setEnabled(true); // non-default state, as if the env pinned it on
  const message = b.restoreDefaults();
  assert(message.includes("pinned by PI_CACHE_* env"), message);
  assert(message.includes("long retention override"), message);
  assertEq(retention.enabled, true, "pinned row keeps its env value");
  assertEq(Object.keys(stored(file)).length, 0, "file still cleared");
});
