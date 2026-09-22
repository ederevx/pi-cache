/**
 * pi-cache — options/env resolution tests.
 * loadOptions() must resolve every PI_CACHE_* override from environment
 * variables, fall back to pi-cache's owned settings JSON for each option,
 * and otherwise use the documented defaults.
 */

import { test, assert, assertEq, scratchDir } from "./harness.ts";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { OptionsLoader } from "../src/constants.ts";

/** Load options from the live process env (tests mutate it around calls). */
const loadOptions = () => new OptionsLoader().load();

/** Save the current env, apply overrides, run fn, restore. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    saved.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A fresh, empty owned-settings path so tests never read the real one. */
function settingsPath(name: string): string {
  const root = join(scratchDir(), "constants");
  mkdirSync(root, { recursive: true });
  return join(root, `${name}-settings.json`);
}

const CLEAN = {
  PI_CACHE_TELEMETRY: undefined,
  PI_CACHE_DEDUP_TOOLS: undefined,
  PI_CACHE_ANCHOR: undefined,
  PI_CACHE_RETENTION_OVERRIDE: undefined,
  PI_CACHE_CANONICALIZE: undefined,
  PI_CACHE_SHARED_KEY: undefined,
  PI_CACHE_FORCE_WARM: undefined,
  PI_CACHE_PIN_SESSION: undefined,
  PI_CACHE_ADVISORY: undefined,
  PI_CACHE_AUTO_COMPACT: undefined,
  PI_CACHE_LEDGER_MAX_ROWS: undefined,
  PI_CACHE_LEDGER_BACKUPS: undefined,
  PI_CACHE_LEDGER_BACKUP_TTL_DAYS: undefined,
  PI_CACHE_LEDGER_BACKUP_MAX_MB: undefined,
  PI_CACHE_BACKUP_DIR: undefined,
  PI_CACHE_FAST_COMPACT: undefined,
  PI_CACHE_FAST_BRANCH_SUMMARY: undefined,
  PI_CACHE_PRESSURE_CONTINUATION: undefined,
  PI_CACHE_PRESSURE_MAX_REQUESTS: undefined,
  PI_CACHE_PRESSURE_KEEP_FRACTION: undefined,
  PI_CACHE_PRESSURE_SUMMARY_COST: undefined,
  PI_CACHE_PRESSURE_DEGRADE_START: undefined,
  PI_CACHE_PRESSURE_DEGRADE_FULL: undefined,
  PI_CACHE_PRESSURE_DEGRADE_GAMMA: undefined,
  PI_CACHE_PRESSURE_COLD_FLOOR: undefined,
  PI_CACHE_TTL_SECONDS: undefined,
};

test("constants: default options", () => {
  withEnv({ ...CLEAN, PI_CACHE_SETTINGS: settingsPath("default") }, () => {
    const opts = loadOptions();
    assertEq(opts.telemetry, true);
    assertEq(opts.dedupTools, true);
    assertEq(opts.anchor, true);
    assertEq(opts.retentionOverride, false);
    assertEq(opts.canonicalize, true);
    assertEq(opts.sharedKey, false);
    assertEq(opts.forceWarm, false);
    assertEq(opts.advisory, true);
    // Cold-window auto-compaction is the default path.
    assertEq(opts.autoCompact, true);
    // Fast cache-aware compaction is on by default; branch summaries have
    // their own independently-defaulted switch.
    assertEq(opts.fastCompact, true);
    assertEq(opts.fastBranchSummary, true);
    assert(opts.cooldownSeconds > 0, "cooldownSeconds default");
    assert(opts.pressureColdFloor > 0 && opts.pressureColdFloor < 1, "coldness floor default");
    assert(opts.cacheTtlSeconds > 0, "cache TTL fallback default");
    // Default ledger lives under the agent dir dot-dir. The suffix is
    // compared against a platform-joined path so the assertion holds on
    // Windows (backslash separators) and POSIX alike.
    assert(opts.ledgerPath.endsWith(join(".pi-cache", "ledger.jsonl")), "default ledger path");
    assertEq(opts.ledgerMaxRows, 20000, "default retained ledger window");
    assertEq(opts.backupKeep, 3, "default backup ring");
    assertEq(opts.backupTtlDays, 7, "default backup TTL");
    assertEq(opts.backupMaxMb, 32, "default backup size cap");
    assert(opts.backupDir.endsWith(join(".pi-cache", "backups")), "default backup dir");
    // Pressure defaults: an ordered degradation onset and a sane cost horizon.
    assert(
      opts.pressureDegradeStart > 0 && opts.pressureDegradeStart < opts.pressureDegradeFull,
      "degradation onset order",
    );
    assertEq(opts.pressureDegradeFull, 0.85);
    assertEq(opts.pressureDegradeGamma, 2);
    assert(opts.pressureContinuation > 0 && opts.pressureContinuation < 1, "continuation default");
    assert(opts.pressureMaxRequests >= 1, "horizon cap default");
    assert(opts.pressureKeepFraction > 0 && opts.pressureKeepFraction < 1, "keep fraction default");
    assertEq(opts.pressureSummaryCost, 0, "fast compaction summary cost default");
    assertEq(opts.pressureMinTokens, 50_000, "minimum context default");
  });
});

test("constants: boolean env parsing", () => {
  withEnv(
    {
      PI_CACHE_TELEMETRY: "1",
      PI_CACHE_DEDUP_TOOLS: "yes",
      PI_CACHE_ANCHOR: "0",
      PI_CACHE_RETENTION_OVERRIDE: "1",
      PI_CACHE_CANONICALIZE: "0",
      PI_CACHE_SHARED_KEY: "1",
      PI_CACHE_FORCE_WARM: "yes",
      PI_CACHE_ADVISORY: "false",
      PI_CACHE_AUTO_COMPACT: "no",
      PI_CACHE_FAST_COMPACT: "off",
      PI_CACHE_FAST_BRANCH_SUMMARY: "0",
      PI_CACHE_SETTINGS: settingsPath("bool"),
    },
    () => {
      const opts = loadOptions();
      assertEq(opts.telemetry, true);
      assertEq(opts.dedupTools, true);
      assertEq(opts.anchor, false);
      assertEq(opts.retentionOverride, true);
      assertEq(opts.canonicalize, false);
      assertEq(opts.sharedKey, true);
      assertEq(opts.forceWarm, true);
      assertEq(opts.advisory, false);
      assertEq(opts.autoCompact, false);
      assertEq(opts.fastCompact, false);
      assertEq(opts.fastBranchSummary, false);
    },
  );
});

test("constants: owned settings file drives the fast-compaction switch", () => {
  const file = settingsPath("switch");
  writeFileSync(file, JSON.stringify({ fastCompaction: false }));
  withEnv({ ...CLEAN, PI_CACHE_SETTINGS: file }, () => {
    assertEq(loadOptions().fastCompact, false);
  });
  writeFileSync(file, JSON.stringify({ fastCompaction: true }));
  withEnv({ ...CLEAN, PI_CACHE_SETTINGS: file }, () => {
    assertEq(loadOptions().fastCompact, true);
  });
});

test("constants: env overrides the owned settings switch", () => {
  const file = settingsPath("override");
  writeFileSync(file, JSON.stringify({ fastCompaction: false }));
  withEnv({ ...CLEAN, PI_CACHE_SETTINGS: file, PI_CACHE_FAST_COMPACT: "1" }, () => {
    assertEq(loadOptions().fastCompact, true);
  });
});

test("constants: owned settings drive every option", () => {
  const file = settingsPath("all-owned");
  writeFileSync(
    file,
    JSON.stringify({
      telemetry: false,
      dedupTools: false,
      anchor: false,
      retentionOverride: false,
      canonicalize: false,
      sharedKey: false,
      forceWarm: false,
      advisory: false,
      autoCompact: false,
    }),
  );
  withEnv({ ...CLEAN, PI_CACHE_SETTINGS: file }, () => {
    const opts = loadOptions();
    assertEq(opts.telemetry, false);
    assertEq(opts.dedupTools, false);
    assertEq(opts.anchor, false);
    assertEq(opts.retentionOverride, false);
    assertEq(opts.canonicalize, false);
    assertEq(opts.sharedKey, false);
    assertEq(opts.forceWarm, false);
    assertEq(opts.advisory, false);
    assertEq(opts.autoCompact, false);
  });
});

test("constants: env overrides an owned option", () => {
  const file = settingsPath("option-override");
  writeFileSync(file, JSON.stringify({ telemetry: false, autoCompact: false }));
  withEnv(
    { ...CLEAN, PI_CACHE_SETTINGS: file, PI_CACHE_TELEMETRY: "1", PI_CACHE_AUTO_COMPACT: "1" },
    () => {
      const opts = loadOptions();
      assertEq(opts.telemetry, true, "env wins over stored");
      assertEq(opts.autoCompact, true, "env wins over stored");
    },
  );
});

test("constants: ledger path override", () => {
  withEnv({ PI_CACHE_LEDGER: "/home/x/ledger.jsonl" }, () => {
    assertEq(loadOptions().ledgerPath, "/home/x/ledger.jsonl");
  });
});

test("constants: numeric parsing falls back on garbage", () => {
  withEnv(
    {
      PI_CACHE_COOLDOWN_SECONDS: "12.5",
      PI_CACHE_TTL_SECONDS: "abc",
      PI_CACHE_PRESSURE_DEGRADE_FULL: "nope",
      PI_CACHE_SETTINGS: settingsPath("numeric"),
    },
    () => {
      const opts = loadOptions();
      assertEq(opts.cooldownSeconds, 12.5);
      assertEq(opts.cacheTtlSeconds, 300, "TTL fallback");
      assertEq(opts.pressureDegradeFull, 0.85, "pressure fallback");
    },
  );
});

// Unused legacy env vars must not crash option resolution.
test("constants: pressure env overrides resolve", () => {
  withEnv(
    {
      PI_CACHE_PRESSURE_CONTINUATION: "0.4",
      PI_CACHE_PRESSURE_MAX_REQUESTS: "3",
      PI_CACHE_PRESSURE_KEEP_FRACTION: "0.5",
      PI_CACHE_PRESSURE_SUMMARY_COST: "12",
      PI_CACHE_PRESSURE_MIN_TOKENS: "30000",
      PI_CACHE_PRESSURE_DEGRADE_START: "0.3",
      PI_CACHE_PRESSURE_DEGRADE_FULL: "0.7",
      PI_CACHE_PRESSURE_DEGRADE_GAMMA: "1.5",
      PI_CACHE_SETTINGS: settingsPath("pressure"),
    },
    () => {
      const opts = loadOptions();
      assertEq(opts.pressureContinuation, 0.4);
      assertEq(opts.pressureMaxRequests, 3);
      assertEq(opts.pressureKeepFraction, 0.5);
      assertEq(opts.pressureSummaryCost, 12);
      assertEq(opts.pressureMinTokens, 30000);
      assertEq(opts.pressureDegradeStart, 0.3);
      assertEq(opts.pressureDegradeFull, 0.7);
      assertEq(opts.pressureDegradeGamma, 1.5);
    },
  );
});

test("constants: removed env vars are ignored harmlessly", () => {
  withEnv(
    {
      PI_CACHE_SOFT_COMPACT: "off",
      PI_CACHE_SOFT_MIN_TOKENS: "999",
      PI_CACHE_COMPACT_DIR: "~/x",
      PI_CACHE_ONCE_MIN_TOKENS: "4444",
      PI_CACHE_SETTINGS: settingsPath("legacy"),
    },
    () => {
      const opts = loadOptions();
      assertEq(opts.autoCompact, true, "auto-compaction unaffected by legacy vars");
      assertEq(opts.ledgerPath.endsWith("ledger.jsonl"), true);
    },
  );
});

test("constants: envPinnedIds lists rows whose env var is present", () => {
  const loader = new OptionsLoader({
    ...CLEAN,
    PI_CACHE_SETTINGS: settingsPath("pinned"),
    PI_CACHE_ANCHOR: "0",
    PI_CACHE_FORCE_WARM: "1",
  } as NodeJS.ProcessEnv);
  const pinned = loader.envPinnedIds();
  assert(pinned.includes("anchor") && pinned.includes("forceWarm"), "present vars pinned");
  assert(!pinned.includes("telemetry"), "absent vars not pinned");
  assertEq(pinned.length, 2);
});
