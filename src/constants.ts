/**
 * pi-cache — module constants and tunables.
 *
 * House style: tunables are centralized here (constants.ts), overridable
 * through PI_CACHE_* environment variables, mirroring the env-var settings
 * idiom common to pi extensions. Durable telemetry and pi-cache's
 * own user settings live in a hidden dot-directory under the agent dir
 * (see user-settings.ts), house-consistent hidden-dot-dir convention.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { UserSettingsStore, type UserSettings } from "./user-settings.ts";

/** Runtime data directory for pi-cache's ledger and settings. Hidden dot-dir. */
const LEDGER_DIR_NAME = ".pi-cache";

export interface PiCacheOptions {
  /** Whether telemetry is recorded at all. */
  telemetry: boolean;
  /** Opt-in tool transforms now default ON; the env var disables them. */
  sortTools: boolean;
  /** Exact-schema tool dedup (opt-in, default on). */
  dedupTools: boolean;
  /** Stable provider session-id pinning for stateless (--no-session)
   *  requests (cross-spawn cache reuse). */
  pinSession: boolean;
  /** Log compaction advisories (observational only). */
  advisory: boolean;
  /** Absolute path of the append-only usage ledger. */
  ledgerPath: string;
  /** Cache-aware automatic compaction (default on). */
  autoCompact: boolean;
  /** Minimum seconds between automatic compactions. */
  cooldownSeconds: number;
  /** Coldness at/below which a non-churned cache is warm (0..1). */
  pressureColdFloor: number;
  /** Fallback provider cache lifetime (s) when the model declares none. */
  cacheTtlSeconds: number;
  /** Fast cache-aware compaction override (default on; /cache-settings switch). */
  fastCompact: boolean;
  /** Separate fast branch-summary override (default on; its own switch). */
  fastBranchSummary: boolean;
  /** Absolute path of pi-cache's owned user-settings JSON. */
  settingsPath: string;
  /** Probabilistic compaction-pressure model tunables. */
  pressureStart: number;
  pressureFull: number;
  pressureGamma: number;
  pressureCacheDiscount: number;
  pressureColdPremium: number;
}

const envBool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

/** parseFloat with a guarded default: unset/unparsable values fall back. */
const envFloat = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
};

const LEDGER_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "ledger.jsonl");
const SETTINGS_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "settings.json");

/** The owned settings file path (env override exists for hermetic tests). */
function userSettingsPath(): string {
  return process.env["PI_CACHE_SETTINGS"] || SETTINGS_DEFAULT;
}

/** Resolve tunables: env overrides first, then owned settings, then defaults. */
export function loadOptions(): PiCacheOptions {
  const stored: UserSettings = new UserSettingsStore(userSettingsPath()).load();
  return {
    telemetry: envBool("PI_CACHE_TELEMETRY", true),
    sortTools: envBool("PI_CACHE_SORT_TOOLS", true),
    dedupTools: envBool("PI_CACHE_DEDUP_TOOLS", true),
    pinSession: envBool("PI_CACHE_PIN_SESSION", true),
    advisory: envBool("PI_CACHE_ADVISORY", true),
    ledgerPath: process.env["PI_CACHE_LEDGER"] || LEDGER_DEFAULT,
    // Cache-favoring features are ON by default; set the env var to
    // 0/off/false to disable.
    autoCompact: envBool("PI_CACHE_AUTO_COMPACT", true),
    cooldownSeconds: envFloat("PI_CACHE_COOLDOWN_SECONDS", 600),
    pressureColdFloor: envFloat("PI_CACHE_PRESSURE_COLD_FLOOR", 0.2),
    cacheTtlSeconds: envFloat("PI_CACHE_TTL_SECONDS", 300),
    // Fast compaction: env beats the owned settings switch beats default on.
    fastCompact: envBool(
      "PI_CACHE_FAST_COMPACT",
      stored.fastCompaction ?? true,
    ),
    // Branch summaries have their own switch (lossier than compaction).
    fastBranchSummary: envBool(
      "PI_CACHE_FAST_BRANCH_SUMMARY",
      stored.fastBranchSummary ?? true,
    ),
    settingsPath: userSettingsPath(),
    // Compaction-pressure ramp. Defaults: begin at 50% usable context,
    // saturate at 85%; a fully warm request halves the pressure and a cold
    // request earns a 25% premium (so pressure can exceed raw utilization).
    pressureStart: envFloat("PI_CACHE_PRESSURE_START", 0.5),
    pressureFull: envFloat("PI_CACHE_PRESSURE_FULL", 0.85),
    pressureGamma: envFloat("PI_CACHE_PRESSURE_GAMMA", 2),
    pressureCacheDiscount: envFloat("PI_CACHE_PRESSURE_CACHE_DISCOUNT", 0.5),
    pressureColdPremium: envFloat("PI_CACHE_PRESSURE_COLD_PREMIUM", 0.25),
  };
}
