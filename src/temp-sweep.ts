/**
 * pi-cache — stale temp-file sweeper.
 *
 * One responsibility: remove `*.tmp*` siblings left by an interrupted
 * atomic write so they cannot accumulate. Fail-open: a missing directory or
 * an undeletable file is ignored, and callers get the count removed.
 */

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export class TempSweeper {
  /** Remove temp files in `dir`; returns how many were removed. */
  sweep(dir: string): number {
    let removed = 0;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.includes(".tmp")) continue;
        try {
          rmSync(join(dir, name), { force: true });
          removed++;
        } catch {
          /* an in-use temp file is left for the next sweep */
        }
      }
    } catch {
      /* directory may not exist yet */
    }
    return removed;
  }
}