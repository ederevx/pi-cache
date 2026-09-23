/**
 * pi-cache — atomic same-directory file replacement.
 *
 * One responsibility: land complete file bytes through a sibling temp
 * file and a rename, so a reader never observes a partial document and a
 * failed write or rename never leaves the temp behind (the sweeper is
 * the backstop). Callers own directory creation.
 */

import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";

export class AtomicFile {
  /** Write `data` to a sibling temp of `path`, then rename it over the
   *  original with `mode`; the temp is removed on any failure. */
  static write(path: string, data: string, mode: number): void {
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, data, { encoding: "utf8", mode });
      AtomicFile.replace(tmp, path);
    } catch (error) {
      AtomicFile.discard(tmp);
      throw error;
    }
  }

  /** Move an existing temp over `path`; a failed rename discards it. */
  static replace(tmp: string, path: string): void {
    try {
      renameSync(tmp, path);
    } catch (error) {
      AtomicFile.discard(tmp);
      throw error;
    }
  }

  /** The file's permissions, or `fallback` when absent. */
  static modeOf(path: string, fallback: number): number {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return fallback;
    }
  }

  /** Best-effort removal of a temp whose write never landed. */
  static discard(tmp: string): void {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* a later sweep clears an undeletable temp */
    }
  }
}