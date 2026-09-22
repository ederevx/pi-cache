/**
 * pi-cache — test runner entry.
 *
 * Run from the repo root:
 *
 *   node --experimental-strip-types --experimental-transform-types tests/run.ts
 *
 * `--experimental-transform-types` is required because the source modules
 * use constructor parameter properties (non-erasable TS). The
 * `@earendil-works/pi-coding-agent` package resolves through the
 * `node_modules` symlink to the pi global install (gitignored).
 *
 * Order: OOP/format lint (python3 tests/oop_lint.py) first, then the
 * unit/e2e suite, then the installer round-trip — a failure anywhere
 * fails the whole run. Scratch lives under ~/tmp/pi-cache-tests-* and
 * the throwaway install home is under ~/tmp as well.
 */

import { registry, cleanupScratch } from "./harness.ts";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 1. OOP + extension-format + feature-removal lint (fast fail).
try {
  execFileSync("python3", ["tests/oop_lint.py"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
} catch {
  console.error("oop lint: FAILED");
  process.exit(1);
}

// Test modules self-register on import.
import "./constants.test.ts";
import "./ledger.test.ts";
import "./sink.test.ts";
import "./backup-store.test.ts";
import "./normalizer.test.ts";
import "./temp-sweep.test.ts";
import "./advisor.test.ts";
import "./affinity.test.ts";
import "./session-pin.test.ts";
import "./signals.test.ts";
import "./provider-ttl.test.ts";
import "./ttl-learner.test.ts";
import "./miss-classifier.test.ts";
import "./warming-observer.test.ts";
import "./trigger.test.ts";
import "./autocompact.test.ts";
import "./economics.test.ts";
import "./context-degradation.test.ts";
import "./pressure.test.ts";
import "./fastcompact.test.ts";
import "./settings.test.ts";
import "./settings-switch.test.ts";
import "./stats.test.ts";
import "./extension.test.ts";

// 2. Unit + end-to-end suite.
await registry.runAll();
cleanupScratch();
if (registry.failed > 0) process.exit(1);

// 3. Installer round-trip (install into a throwaway agent home,
//    uninstall, assert nothing is left behind).
try {
  execFileSync("bash", ["tests/scripts_test.sh"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  console.log("scripts test: passed");
} catch {
  console.error("scripts test: FAILED");
  process.exit(1);
}
