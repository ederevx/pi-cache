/**
 * pi-cache — module constants and tunables.
 *
 * House style: tunables are centralized here (constants.ts), overridable
 * through PI_CACHE_* environment variables, mirroring the env-var settings
 * idiom used by pi extensions. No config JSON is written; durable
 * telemetry lives in a hidden dot-directory under the agent dir, matching
 * the `a local hook directory/` precedent.
 */

import * as os from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Runtime data directory for pi-cache's ledger. Hidden dot-dir: house rule. */
export const LEDGER_DIR_NAME = ".pi-cache";

export interface PiCacheOptions {
  /** Whether telemetry is recorded at all. */
  telemetry: boolean;
  /** Deterministic tool order (opt-in). */
  sortTools: boolean;
  /** Exact-schema tool dedup (opt-in). */
  dedupTools: boolean;
  /** Log compaction advisories (observational only). */
  advisory: boolean;
  /** Absolute path of the append-only usage ledger. */
  ledgerPath: string;
  /** Warmth threshold (0..1) above which compaction advisories fire. */
  warmRatioThreshold: number;
  /** Context size (tokens) above which a warm-cache advisory is useful. */
  advisoryMinTokens: number;
  /** Cache-aware automatic compaction (opt-in, off). */
  autoCompact: boolean;
  coldRatio: number;
  minContextPercent: number;
  cooldownSeconds: number;
  cooldownTurns: number;
  minGapSeconds: number;
  /** Soft per-turn compaction cadence (off | cold | always). */
  softCompactMode: "off" | "cold" | "always";
  /** Minimum uncached turns before the soft cadence acts (default: every turn). */
  softCompactMinDeltaTurns: number;
}

const envBool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

const LEDGER_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "ledger.jsonl");

/** Resolve tunables: env overrides first, then defaults. */
export function loadOptions(): PiCacheOptions {
  return {
    telemetry: envBool("PI_CACHE_TELEMETRY", true),
    sortTools: envBool("PI_CACHE_SORT_TOOLS", false),
    dedupTools: envBool("PI_CACHE_DEDUP_TOOLS", false),
    advisory: envBool("PI_CACHE_ADVISORY", true),
    ledgerPath: process.env["PI_CACHE_LEDGER"] || LEDGER_DEFAULT,
    warmRatioThreshold: 0.6,
    advisoryMinTokens: 50_000,
    autoCompact: envBool("PI_CACHE_AUTO_COMPACT", false),
    coldRatio: 0.05,
    minContextPercent: 60,
    cooldownSeconds: parseFloat(process.env["PI_CACHE_COOLDOWN_SECONDS"] ?? "600"),
    cooldownTurns: 5,
    minGapSeconds: parseFloat(process.env["PI_CACHE_MIN_GAP_SECONDS"] ?? "240"),
    softCompactMode: (process.env["PI_CACHE_SOFT_COMPACT"] || "off") as "off" | "cold" | "always",
    softCompactMinDeltaTurns: parseInt(process.env["PI_CACHE_SOFT_MIN_DELTA_TURNS"] ?? "1", 10),
  };
}
