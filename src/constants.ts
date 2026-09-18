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
  /** Opt-in tool transforms now default ON; the env var disables them. */
  sortTools: boolean;
  /** Exact-schema tool dedup (opt-in, default on). */
  dedupTools: boolean;
  /** Log compaction advisories (observational only). */
  advisory: boolean;
  /** Absolute path of the append-only usage ledger. */
  ledgerPath: string;
  /** Warmth threshold (0..1) above which compaction advisories fire. */
  warmRatioThreshold: number;
  /** Context size (tokens) above which a warm-cache advisory is useful. */
  advisoryMinTokens: number;
  /** Cache-aware automatic compaction (default on). */
  autoCompact: boolean;
  coldRatio: number;
  minContextPercent: number;
  cooldownSeconds: number;
  cooldownTurns: number;
  minGapSeconds: number;
  /** Soft per-turn compaction cadence (default always; env disables). */
  softCompactMode: "off" | "cold" | "always";
  /** Minimum uncached turns before the soft cadence acts (default: every turn). */
  softCompactMinDeltaTurns: number;
  /**
   * Fast soft compaction: replace the uncached delta with a fixed stub
   * (no summarizer LLM call). Default on; set to 0 to restore the
   * cache-aware LLM-summary proposal path.
   */
  softFast: boolean;
  /**
   * Auto-resume: continue the agent once after a successful soft
   * compaction so the model reacts to the compacted context immediately
   * (one user turn -> one compaction -> one continuation run). Default on;
   * set to 0 to disable.
   */
  softAutoResume: boolean;
}

const envBool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

const SOFT_DEFAULT: "off" | "cold" | "always" = "always";

/** Parse PI_CACHE_SOFT_COMPACT: "0"/"off"/"false"/"no" disable; "cold" selects cold-window only. */
const parseSoftMode = (raw: string | undefined): "off" | "cold" | "always" => {
  if (raw === undefined || raw === "") return SOFT_DEFAULT;
  switch (raw.toLowerCase()) {
    case "0":
    case "off":
    case "false":
    case "no":
      return "off";
    case "cold":
      return "cold";
    default:
      return "always";
  }
};

const LEDGER_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "ledger.jsonl");

/** Resolve tunables: env overrides first, then defaults. */
export function loadOptions(): PiCacheOptions {
  return {
    telemetry: envBool("PI_CACHE_TELEMETRY", true),
    sortTools: envBool("PI_CACHE_SORT_TOOLS", true),
    dedupTools: envBool("PI_CACHE_DEDUP_TOOLS", true),
    advisory: envBool("PI_CACHE_ADVISORY", true),
    ledgerPath: process.env["PI_CACHE_LEDGER"] || LEDGER_DEFAULT,
    warmRatioThreshold: 0.6,
    advisoryMinTokens: 50_000,
    // All cache-favoring features are ON by default; set the env var to
    // 0/off/false to disable (e.g. PI_CACHE_SOFT_COMPACT=off).
    autoCompact: envBool("PI_CACHE_AUTO_COMPACT", true),
    coldRatio: 0.05,
    minContextPercent: 60,
    cooldownSeconds: parseFloat(process.env["PI_CACHE_COOLDOWN_SECONDS"] ?? "600"),
    cooldownTurns: 5,
    minGapSeconds: parseFloat(process.env["PI_CACHE_MIN_GAP_SECONDS"] ?? "240"),
    softCompactMode: parseSoftMode(process.env["PI_CACHE_SOFT_COMPACT"]),
    softCompactMinDeltaTurns: parseInt(process.env["PI_CACHE_SOFT_MIN_DELTA_TURNS"] ?? "1", 10),
    softFast: envBool("PI_CACHE_SOFT_FAST", true),
    softAutoResume: envBool("PI_CACHE_SOFT_AUTORESUME", true),
  };
}
