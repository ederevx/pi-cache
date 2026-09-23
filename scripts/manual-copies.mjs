/**
 * Remove the manual-install copies a prior `scripts/install.sh` left so a
 * pi package install stays the single loader source.
 *
 * The manual installer copies src/*.ts into <pi-home>/extensions/pi-cache
 * and records them in <pi-home>/.pi-cache/manifest.json ("owned"). With
 * the package installed, pi loads src/index.ts from the package clone and
 * a manual copy beside it loads the same extension twice, aborting every
 * new session with tool-conflict errors. The rule mirrors pi-daemon's
 * --package mode: a path goes when the manual manifest owned it, or when
 * it is byte-identical to this clone's src counterpart (a copy whose
 * manifest is gone). Unrelated files are never touched.
 */

import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

function sameBytes(dest, source) {
	if (!existsSync(dest) || !existsSync(source)) return false;
	if (!statSync(dest).isFile()) return false;
	return dest !== source
		&& readFileSync(dest).equals(readFileSync(source));
}

function normalized(path) {
	return path.replace(/\\/g, "/");
}

/** Owns the removal of one package's manual-install copies. */
export class ManualCopyCleaner {
	/** @param manifestPath the manual install's manifest.json
	 *  @param destDir the manual install's extension directory
	 *  @param srcDir this clone's counterpart the bytes are compared to */
	constructor(manifestPath, destDir, srcDir) {
		this.manifestPath = manifestPath;
		this.destDir = destDir;
		this.srcDir = srcDir;
	}

	/** The manifest's recorded paths, or an empty set when absent or
	 *  unreadable: a broken manifest must not widen removal. */
	manifestPaths() {
		try {
			const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8"));
			const paths = parsed.owned ?? parsed.files ?? [];
			return new Set(paths.map((p) => normalized(p)));
		} catch {
			return new Set();
		}
	}

	/** Removes every manual copy under destDir that the manifest owned
	 *  or whose bytes match this clone's src counterpart, then prunes
	 *  destDir when it is left empty. Returns the removed paths; never
	 *  throws — a failed removal only skips that path. */
	clean() {
		const manifestPaths = this.manifestPaths();
		const removed = [];
		const prefix = normalized(this.destDir) + "/";
		for (const path of manifestPaths) {
			try {
				if (!path.startsWith(prefix) || !existsSync(path)) continue;
				if (statSync(path).isDirectory()) continue;
				rmSync(path, { force: true });
				removed.push(path);
			} catch {
				// fail-soft: keep the copy rather than abort the install
			}
		}
		try {
			for (const name of readdirSync(this.srcDir)) {
				if (!name.endsWith(".ts")) continue;
				const dest = join(this.destDir, name);
				try {
					if (!existsSync(dest)) continue;
					if (manifestPaths.has(normalized(dest))) continue;
					if (!sameBytes(dest, join(this.srcDir, name))) continue;
					rmSync(dest, { force: true });
					removed.push(dest);
				} catch {
					// fail-soft per file
				}
			}
		} catch {
			// no src/ in this checkout shape
		}
		try {
			if (existsSync(this.destDir)
				&& readdirSync(this.destDir).length === 0) {
				rmdirSync(this.destDir);
				removed.push(this.destDir + " (pruned, empty)");
			}
		} catch {
			// fail-soft: leave the empty dir rather than abort
		}
		return removed;
	}
}

/** Default pi-cache locations, honoring the installer's env overrides. */
export function piCachePaths(repoRoot) {
	const piHome = process.env.PI_CODING_AGENT_DIR
		|| join(homedir(), ".pi", "agent");
	return {
		manifestPath: join(piHome, ".pi-cache", "manifest.json"),
		destDir: join(piHome, "extensions", "pi-cache"),
		srcDir: join(repoRoot, "src"),
	};
}