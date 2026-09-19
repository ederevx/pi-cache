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
 * The suite is zero-dependency (node built-ins only). Scratch lives under
 * ~/tmp/pi-cache-tests-* and is removed when the run finishes.
 */

import { registry, cleanupScratch } from "./harness.ts";

// Test modules self-register on import.
import "./constants.test.ts";
import "./ledger.test.ts";
import "./normalizer.test.ts";
import "./advisor.test.ts";
import "./affinity.test.ts";
import "./session-pin.test.ts";
import "./autocompact.test.ts";
import "./extension.test.ts";

await registry.runAll();
cleanupScratch();
if (registry.failed > 0) process.exit(1);