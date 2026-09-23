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

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { AtomicFile } from "./atomic-file.ts";

export interface UserSettings {
  /** Record per-request cache usage to the ledger. */
  telemetry?: boolean;
  /** Drop exact-duplicate tool schemas from the payload. */
  dedupTools?: boolean;
  /** Pin a fourth Anthropic breakpoint on stable mid-history. */
  anchor?: boolean;
  /** Rewrite cache markers to the long retention tier per request. */
  retentionOverride?: boolean;
  /** Canonicalize skill/project listings in the system prompt. */
  canonicalize?: boolean;
  /** Derive OpenAI prompt_cache_key from the prefix head. */
  sharedKey?: boolean;
  /** Force pi's cache-warming decision to "warm". */
  forceWarm?: boolean;
  /** Render the miss taxonomy in /cache-stats. */
  missDiagnosis?: boolean;
  /** Log compaction advisories. */
  advisory?: boolean;
  /** Cache-aware automatic compaction. */
  autoCompact?: boolean;
  /** Fast cache-aware compaction override (the /cache-settings switch). */
  fastCompaction?: boolean;
  /** Separate switch for the /tree branch-summary overlay. */
  fastBranchSummary?: boolean;
  /** Deterministic dropped-span digest after the fast stub. */
  fastDigest?: boolean;
}

export class UserSettingsStore {
  constructor(private readonly file: string) {}

  load(): UserSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        return UserSettingsStore.sanitize(parsed as Record<string, unknown>);
      }
    } catch {
      /* absent or corrupt: fall back to defaults */
    }
    return {};
  }

  /** Keep only known keys whose value is a real boolean. Every owned
   *  option is a switch, so a truthy non-boolean in a hand-edited or
   *  corrupt file (e.g. `"telemetry": "no"`) must not flip it on: the
   *  field falls back to its default, exactly like an absent key. */
  private static sanitize(raw: Record<string, unknown>): UserSettings {
    const settings: UserSettings = {};
    for (const key of UserSettingsStore.BOOLEAN_KEYS) {
      if (typeof raw[key] === "boolean") settings[key] = raw[key] as boolean;
    }
    return settings;
  }

  private static readonly BOOLEAN_KEYS: Array<keyof UserSettings> = [
    "telemetry",
    "dedupTools",
    "anchor",
    "retentionOverride",
    "canonicalize",
    "sharedKey",
    "forceWarm",
    "advisory",
    "autoCompact",
    "fastCompaction",
    "fastBranchSummary",
    "fastDigest",
  ];

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

  /** Write the complete document to a sibling temp, then rename it over
   *  the original, preserving its permissions (owner-only by default). */
  private writeAtomic(settings: UserSettings): void {
    mkdirSync(dirname(this.file), { recursive: true });
    AtomicFile.write(
      this.file,
      JSON.stringify(settings, null, 2) + "\n",
      AtomicFile.modeOf(this.file, 0o600),
    );
  }
}
