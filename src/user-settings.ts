/**
 * pi-cache — owned user settings store.
 *
 * One responsibility: read and atomically update pi-cache's own settings
 * JSON under the agent dot-dir. pi 0.86 has no extension-declared setting
 * surface (audit: no `registerSetting`), so the extension owns this small
 * file and exposes it through `/cache-settings`. Writes go to a sibling
 * temp file and are renamed into place, so a reader never observes a
 * partial document (house rule for files running software reads).
 * Fail-open on read: a missing or corrupt file yields defaults.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UserSettings {
  /** Record per-request cache usage to the ledger. */
  telemetry?: boolean;
  /** Deterministic tool order for byte-stable prefixes. */
  sortTools?: boolean;
  /** Drop exact-duplicate tool schemas from the payload. */
  dedupTools?: boolean;
  /** Stable provider session-id pinning for stateless requests. */
  pinSession?: boolean;
  /** Log compaction advisories. */
  advisory?: boolean;
  /** Cache-aware automatic compaction. */
  autoCompact?: boolean;
  /** Fast cache-aware compaction override (the /cache-settings switch). */
  fastCompaction?: boolean;
  /** Separate switch for the /tree branch-summary overlay. */
  fastBranchSummary?: boolean;
}

export class UserSettingsStore {
  constructor(private readonly file: string) {}

  load(): UserSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object") return parsed as UserSettings;
    } catch {
      /* absent or corrupt: fall back to defaults */
    }
    return {};
  }

  /** Merge `patch` into the stored document and persist atomically. */
  save(patch: UserSettings): UserSettings {
    const next: UserSettings = { ...this.load(), ...patch };
    this.writeAtomic(next);
    return next;
  }

  /** Set one owned boolean flag and persist it (settings switch board). */
  saveFlag(id: keyof UserSettings, enabled: boolean): UserSettings {
    const patch: UserSettings = {};
    patch[id] = enabled;
    return this.save(patch);
  }

  /** Write the complete document to a sibling temp file, then rename it. */
  private writeAtomic(settings: UserSettings): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
