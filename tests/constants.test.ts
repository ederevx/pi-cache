/**
 * pi-cache — options/env resolution tests.
 * loadOptions() must resolve every PI_CACHE_* override from environment
 * variables and fall back to the documented defaults.
 */

import { test, assert, assertEq } from "./harness.ts";
import { loadOptions } from "../src/constants.ts";

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

test("constants: default options", () => {
  withEnv(
    {
      PI_CACHE_TELEMETRY: undefined,
      PI_CACHE_SORT_TOOLS: undefined,
      PI_CACHE_DEDUP_TOOLS: undefined,
      PI_CACHE_PIN_SESSION: undefined,
      PI_CACHE_ADVISORY: undefined,
      PI_CACHE_AUTO_COMPACT: undefined,
    },
    () => {
      const opts = loadOptions();
      assertEq(opts.telemetry, true);
      assertEq(opts.sortTools, true);
      assertEq(opts.dedupTools, true);
      assertEq(opts.pinSession, true);
      assertEq(opts.advisory, true);
      // Cold-window auto-compaction is the default path.
      assertEq(opts.autoCompact, true);
      assert(opts.cooldownSeconds > 0, "cooldownSeconds default");
      assert(opts.minGapSeconds > 0, "minGapSeconds default");
      // Default ledger lives under the agent dir dot-dir.
      assert(opts.ledgerPath.endsWith(".pi-cache/ledger.jsonl"), "default ledger path");
      // Removed soft-compaction surface is gone from the options.
      assert(!("softCompactMode" in opts), "no soft-compact option");
      assert(!("compactDir" in opts), "no compact-store option");
    },
  );
});

test("constants: boolean env parsing", () => {
  withEnv(
    {
      PI_CACHE_TELEMETRY: "1",
      PI_CACHE_SORT_TOOLS: "true",
      PI_CACHE_DEDUP_TOOLS: "yes",
      PI_CACHE_PIN_SESSION: "0",
      PI_CACHE_ADVISORY: "false",
      PI_CACHE_AUTO_COMPACT: "no",
    },
    () => {
      const opts = loadOptions();
      assertEq(opts.telemetry, true);
      assertEq(opts.sortTools, true);
      assertEq(opts.dedupTools, true);
      assertEq(opts.pinSession, false);
      assertEq(opts.advisory, false);
      assertEq(opts.autoCompact, false);
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
      PI_CACHE_MIN_GAP_SECONDS: "abc",
    },
    () => {
      const opts = loadOptions();
      assertEq(opts.cooldownSeconds, 12.5);
      assert(opts.minGapSeconds === 240, "minGap fallback");
    },
  );
});

// Unused legacy env vars must not crash option resolution.
test("constants: removed env vars are ignored harmlessly", () => {
  withEnv(
    {
      PI_CACHE_SOFT_COMPACT: "off",
      PI_CACHE_SOFT_MIN_TOKENS: "999",
      PI_CACHE_COMPACT_DIR: "~/x",
      PI_CACHE_ONCE_MIN_TOKENS: "4444",
    },
    () => {
      const opts = loadOptions();
      assertEq(opts.autoCompact, true, "auto-compaction unaffected by legacy vars");
      assertEq(opts.ledgerPath.endsWith("ledger.jsonl"), true);
    },
  );
});