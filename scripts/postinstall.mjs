#!/usr/bin/env node
/**
 * Package-install adoption for pi-cache, run by npm after any `pi
 * install`/`pi update` of this package:
 *
 * 1. Fail-soft settings guard: keep at most one packages entry that
 *    installs this package. A git pin and a local-path install of the
 *    same checkout coexist as two entries, both extensions load, and pi
 *    aborts startup with tool-conflict errors. See pi-daemon's
 *    scripts/settings-reconciler.mjs for the rule and its rationale.
 * 2. Manual-copy cleanup: drop the extension copies a prior manual
 *    `scripts/install.sh` left under extensions/pi-cache, so the package
 *    stays the single loader source. See manual-copies.mjs for the rule.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsReconciler } from "./settings-reconciler.mjs";
import { ManualCopyCleaner, piCachePaths } from "./manual-copies.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function version() {
	try {
		return JSON.parse(
			readFileSync(join(repoRoot, "package.json"), "utf8")).version;
	} catch {
		return undefined;
	}
}

try {
	const dropped = new SettingsReconciler(
		SettingsReconciler.defaultPath(), version(), "pi-cache").reconcile();
	if (dropped.length > 0) {
		process.stderr.write(
			"pi-cache: removed duplicate package entries that would load " +
			"its extensions twice: " + dropped.join(", ") + "\n");
	}
} catch (err) {
	process.stderr.write(
		"pi-cache: settings reconciliation skipped (" +
		(err?.message ?? err) + ")\n");
}

try {
	const { manifestPath, destDir, srcDir } = piCachePaths(repoRoot);
	const removed = new ManualCopyCleaner(manifestPath, destDir, srcDir).clean();
	if (removed.length > 0) {
		process.stderr.write(
			"pi-cache: removed manual-install copies that would load beside " +
			"the package (single-loader rule): " + removed.join(", ") + "\n");
	}
} catch (err) {
	process.stderr.write(
		"pi-cache: manual-copy cleanup skipped (" +
		(err?.message ?? err) + ")\n");
}
process.exit(0);