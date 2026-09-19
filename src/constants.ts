/**
 * pi-cache — module constants and tunables.
 *
 * House style: tunables are centralized here (constants.ts), overridable
 * through PI_CACHE_* environment variables, mirroring the env-var settings
 * idiom used by pi extensions. No config JSON is written; durable
 * telemetry lives in a hidden dot-directory under the agent dir, matching
 * the `a local hook directory/` precedent.
 */

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
  /** Stable provider session-id pinning for stateless (--no-session)
   *  requests (cross-spawn cache reuse). */
  pinSession: boolean;
  /** Log compaction advisories (observational only). */
  advisory: boolean;
  /** Absolute path of the append-only usage ledger. */
  ledgerPath: string;
  /** Cache-aware automatic compaction in cold windows (default on). */
  autoCompact: boolean;
  /** Minimum seconds between automatic compactions. */
  cooldownSeconds: number;
  /** Minimum idle gap (s) that indicates a provider TTL expired. */
  minGapSeconds: number;
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

/** Resolve tunables: env overrides first, then defaults. */
export function loadOptions(): PiCacheOptions {
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
    minGapSeconds: envFloat("PI_CACHE_MIN_GAP_SECONDS", 240),
  };
}