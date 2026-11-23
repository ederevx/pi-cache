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
  PI_CACHE_MIDTERM: undefined,
  PI_CACHE_LEDGER_MAX_ROWS: undefined,
  PI_CACHE_MODEL_PARAMS: undefined,
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
  PI_CACHE_PRESSURE_DEGRADE_FLOOR_START_TOKENS: undefined,
  PI_CACHE_PRESSURE_DEGRADE_FLOOR_FULL_TOKENS: undefined,
  PI_CACHE_PRESSURE_DEGRADE_FLOOR: undefined,
  PI_CACHE_PRESSURE_DEGRADE_HALF_LIFE_MINUTES: undefined,
  PI_CACHE_PRESSURE_DEGRADE_AGE_GAP_SECONDS: undefined,
  PI_CACHE_PRESSURE_COLD_FLOOR: undefined,
  PI_CACHE_TTL_SECONDS: undefined,
  PI_CACHE_TTL_PROFILES: undefined,
  PI_CACHE_MODEL_PARAMS_URL: undefined,
  PI_CACHE_MODEL_PARAMS_MAX_AGE_MS: undefined,
  PI_CACHE_MODEL_PARAMS_RETRY_MS: undefined,
  PI_CACHE_MODEL_PARAMS_TIMEOUT_MS: undefined,
  PI_CACHE_MODEL_PARAMS_MAX_MODELS: undefined,
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
    assertEq(opts.midterm, true, "midterm compaction default");
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
    assert(
      opts.modelParamsPath.endsWith(join(".pi-cache", "model-params.json")),
      "default model-params path",
    );
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
      PI_CACHE_MIDTERM: "0",
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
      assertEq(opts.midterm, false);
      assertEq(opts.fastCompact, false);
      assertEq(opts.fastBranchSummary, false);
      // Every enabled/disabled spelling pi-cache accepts.
      const spellings: Array<[string, boolean]> = [
        ["1", true],
        ["on", true],
        ["yes", true],
        ["0", false],
        ["off", false],
        ["no", false],
        ["false", false],
      ];
      for (const [raw, expected] of spellings) {
        withEnv({ PI_CACHE_TELEMETRY: raw }, () => {
          assertEq(loadOptions().telemetry, expected, `PI_CACHE_TELEMETRY=${raw}`);
        });
      }
    },
  );
});

test("constants: the owned settings file drives every switch and env wins over it", () => {
  const rows: Array<{
    label: string;
    stored: Record<string, boolean>;
    env?: Record<string, string>;
    expected: Record<string, boolean>;
  }> = [
    { label: "a stored switch off", stored: { fastCompaction: false }, expected: { fastCompact: false } },
    { label: "a stored switch on", stored: { fastCompaction: true }, expected: { fastCompact: true } },
    {
      label: "env overrides a stored switch",
      stored: { fastCompaction: false },
      env: { PI_CACHE_FAST_COMPACT: "1" },
      expected: { fastCompact: true },
    },
    {
      label: "every switch reads the stored file",
      stored: {
        telemetry: false,
        dedupTools: false,
        anchor: false,
        retentionOverride: false,
        canonicalize: false,
        sharedKey: false,
        forceWarm: false,
        advisory: false,
        autoCompact: false,
      },
      expected: {
        telemetry: false,
        dedupTools: false,
        anchor: false,
        retentionOverride: false,
        canonicalize: false,
        sharedKey: false,
        forceWarm: false,
        advisory: false,
        autoCompact: false,
      },
    },
    {
      label: "env wins over several stored options",
      stored: { telemetry: false, autoCompact: false },
      env: { PI_CACHE_TELEMETRY: "1", PI_CACHE_AUTO_COMPACT: "1" },
      expected: { telemetry: true, autoCompact: true },
    },
  ];
  for (const [index, row] of rows.entries()) {
    const file = settingsPath(`precedence-${index}`);
    writeFileSync(file, JSON.stringify(row.stored));
    withEnv({ ...CLEAN, PI_CACHE_SETTINGS: file, ...row.env }, () => {
      const opts = loadOptions() as unknown as Record<string, unknown>;
      for (const [key, expected] of Object.entries(row.expected)) {
        assertEq(opts[key], expected, `${row.label}: ${key}`);
      }
    });
  }
});

test("constants: the model-parameter endpoint and its timings are configured", () => {
  withEnv({ ...CLEAN, PI_CACHE_SETTINGS: settingsPath("params") }, () => {
    const opts = loadOptions();
    assert(opts.modelParamsUrl.endsWith("/models"), "default model-list endpoint");
    assertEq(opts.modelParamsUrl, "https://openrouter.ai/api/v1/models", "default endpoint");
    assertEq(opts.modelParamsMaxAgeMs, 300_000, "default freshness bound");
    assertEq(opts.modelParamsRetryMs, 60_000, "default retry gap");
    assertEq(opts.modelParamsTimeoutMs, 5_000, "default timeout");
    assertEq(opts.modelParamsMaxModels, 5000, "catalog size cap default");
    assertEq(opts.cacheTtlProfiles.length, 6, "default TTL profiles");
  });
  withEnv(
    {
      ...CLEAN,
      PI_CACHE_SETTINGS: settingsPath("params-override"),
      PI_CACHE_MODEL_PARAMS_URL: " https://pricing.example.com/models ",
      PI_CACHE_MODEL_PARAMS_MAX_AGE_MS: "1000",
      PI_CACHE_MODEL_PARAMS_RETRY_MS: "2000",
      PI_CACHE_MODEL_PARAMS_TIMEOUT_MS: "3000",
      PI_CACHE_MODEL_PARAMS_MAX_MODELS: "10",
    },
    () => {
      const opts = loadOptions();
      assertEq(opts.modelParamsUrl, "https://pricing.example.com/models", "trimmed override");
      assertEq(opts.modelParamsMaxAgeMs, 1000);
      assertEq(opts.modelParamsRetryMs, 2000);
      assertEq(opts.modelParamsTimeoutMs, 3000);
      assertEq(opts.modelParamsMaxModels, 10);
    },
  );
  withEnv(
    { ...CLEAN, PI_CACHE_SETTINGS: settingsPath("params-off"), PI_CACHE_MODEL_PARAMS_URL: "" },
    () => {
      assertEq(loadOptions().modelParamsUrl, "", "an empty value disables the pull");
    },
  );
  // Timings outside their bounds fall back to the documented defaults; a
  // zero age or retry gap is legal.
  const bounds: Array<[string, Record<string, string>, Record<string, number>]> = [
    [
      "a negative age stales every snapshot",
      {
        PI_CACHE_MODEL_PARAMS_MAX_AGE_MS: "-1",
        PI_CACHE_MODEL_PARAMS_RETRY_MS: "-5",
        PI_CACHE_MODEL_PARAMS_TIMEOUT_MS: "0",
        PI_CACHE_MODEL_PARAMS_MAX_MODELS: "0",
      },
      {
        modelParamsMaxAgeMs: 300_000,
        modelParamsRetryMs: 60_000,
        modelParamsTimeoutMs: 5_000,
        modelParamsMaxModels: 5000,
      },
    ],
    [
      "a zero age is a legal always-refresh bound",
      { PI_CACHE_MODEL_PARAMS_MAX_AGE_MS: "0", PI_CACHE_MODEL_PARAMS_RETRY_MS: "0" },
      { modelParamsMaxAgeMs: 0, modelParamsRetryMs: 0 },
    ],
    [
      "an out-of-range delay falls back",
      { PI_CACHE_MODEL_PARAMS_TIMEOUT_MS: "2147483648" },
      { modelParamsTimeoutMs: 5_000 },
    ],
  ];
  for (const [index, [label, env, expected]] of bounds.entries()) {
    withEnv({ ...CLEAN, PI_CACHE_SETTINGS: settingsPath(`params-bounds-${index}`), ...env }, () => {
      const opts = loadOptions() as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected)) {
        assertEq(opts[key], value, `${label}: ${key}`);
      }
    });
  }
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

test("options: the degradation floor and the midterm percent resolve", () => {
  withEnv(
    {
      PI_CACHE_PRESSURE_DEGRADE_FLOOR_START_TOKENS: undefined,
      PI_CACHE_PRESSURE_DEGRADE_FLOOR_FULL_TOKENS: undefined,
      PI_CACHE_PRESSURE_DEGRADE_FLOOR_START_FRACTION: undefined,
      PI_CACHE_PRESSURE_DEGRADE_FLOOR_FULL_FRACTION: undefined,
      PI_CACHE_PRESSURE_DEGRADE_FLOOR: undefined,
      PI_CACHE_PRESSURE_DEGRADE_HALF_LIFE_MINUTES: undefined,
      PI_CACHE_PRESSURE_DEGRADE_AGE_GAP_SECONDS: undefined,
      PI_CACHE_MIDTERM_MIN_PERCENT: undefined,
    },
    () => {
      const defaults = loadOptions();
      assertEq(defaults.pressureDegradeFloorStartTokens, 32_768, "floor onset default");
      assertEq(defaults.pressureDegradeFloorFullTokens, 131_072, "floor plateau default");
      assertEq(defaults.pressureDegradeFloorStartFraction, 0.125, "band onset fraction default");
      assertEq(defaults.pressureDegradeFloorFullFraction, 0.5, "band plateau fraction default");
      assertEq(defaults.pressureDegradeFloor, 0.5, "floor default");
      assertEq(defaults.pressureDegradeHalfLifeMinutes, 60, "half-life default");
      assertEq(defaults.pressureDegradeAgeGapSeconds, 300, "age gap cap default");
      assertEq(defaults.midtermMinPercent, 50, "midterm percent default");
    },
  );
  withEnv(
    {
      PI_CACHE_PRESSURE_DEGRADE_FLOOR_START_TOKENS: "64000",
      PI_CACHE_PRESSURE_DEGRADE_FLOOR_FULL_TOKENS: "128000",
      PI_CACHE_PRESSURE_DEGRADE_FLOOR_START_FRACTION: "0.2",
      PI_CACHE_PRESSURE_DEGRADE_FLOOR_FULL_FRACTION: "0.6",
      PI_CACHE_PRESSURE_DEGRADE_FLOOR: "0.25",
      PI_CACHE_PRESSURE_DEGRADE_HALF_LIFE_MINUTES: "30",
      PI_CACHE_PRESSURE_DEGRADE_AGE_GAP_SECONDS: "120",
      PI_CACHE_MIDTERM_MIN_PERCENT: "25",
    },
    () => {
      const overridden = loadOptions();
      assertEq(overridden.pressureDegradeFloorStartTokens, 64_000);
      assertEq(overridden.pressureDegradeFloorFullTokens, 128_000);
      assertEq(overridden.pressureDegradeFloorStartFraction, 0.2);
      assertEq(overridden.pressureDegradeFloorFullFraction, 0.6);
      assertEq(overridden.pressureDegradeFloor, 0.25);
      assertEq(overridden.pressureDegradeHalfLifeMinutes, 30);
      assertEq(overridden.pressureDegradeAgeGapSeconds, 120);
      assertEq(overridden.midtermMinPercent, 25);
    },
  );
});
