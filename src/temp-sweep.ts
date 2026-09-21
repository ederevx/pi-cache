/**
 * pi-cache — stale temp-file sweeper.
 *
 * One responsibility: remove `*.tmp` siblings left by an interrupted
 * atomic write, while leaving recent temps alone so a sibling process's
 * in-flight write is never deleted. Only the exact `.tmp` suffix pi-cache
 * writes is matched, so an unrelated file that merely mentions `.tmp` is
 * never touched. Fail-open: a missing directory or an undeletable file is
 * ignored, and callers get the count removed.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Default grace before a temp file is considered abandoned. */
const DEFAULT_STALE_MS = 60 * 60 * 1000;

export class TempSweeper {
  constructor(private readonly staleMs: number = DEFAULT_STALE_MS) {}

  /** Remove abandoned temp files in `dir`; returns how many were removed. */
  sweep(dir: string): number {
    const cutoff = Date.now() - this.staleMs;
    let removed = 0;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".tmp")) continue;
        const full = join(dir, name);
        try {
          if (statSync(full).mtimeMs > cutoff) continue; // possibly in-flight
          rmSync(full, { force: true });
          removed++;
        } catch {
          /* leave it for the next sweep */
        }
      }
    } catch {
      /* directory may not exist yet */
    }
    return removed;
  }
}
