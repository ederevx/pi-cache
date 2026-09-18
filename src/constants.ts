/**
 * pi-cache — module constants and tunables.
 *
 * House style: tunables are centralized here (constants.ts), overridable
 * through PI_CACHE_* environment variables, mirroring the env-var settings
 * idiom used by pi extensions. No config JSON is written; durable
 * telemetry lives in a hidden dot-directory under the agent dir, matching
 * the `a local hook directory/` precedent.
 */

import { readFileSync } from "node:fs";
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
  /** Cache-aware automatic compaction (default on). */
  autoCompact: boolean;
  cooldownSeconds: number;
  minGapSeconds: number;
  /** Soft compaction cadence (default once; env overrides). */
  softCompactMode: "off" | "once";
  /** Minimum uncached turns before the soft cadence acts (default: every turn). */
  softCompactMinDeltaTurns: number;
  /**
   * One-shot trigger (mode "once"): fire the single fast compaction at the
   * first output after the live context reaches this many tokens — the
   * moment older turns would first be swept into summarized history — then
   * never compact again. Default mirrors pi's keepRecentTokens so the sweep
   * happens exactly as content is about to become history.
   */
  softOnceMinTokens: number;
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

const SOFT_DEFAULT: "off" | "once" = "once";

/**
 * Parse PI_CACHE_SOFT_COMPACT: "0"/"off"/"false"/"no" disable; "once"
 * (default) compacts a single time right after output, then never again.
 * Any other value honors the "once" default (the per-turn cadences
 * "cold"/"always" were removed — they self-defeated the cache).
 */
const parseSoftMode = (raw: string | undefined): "off" | "once" => {
  if (raw === undefined || raw === "") return SOFT_DEFAULT;
  switch (raw.toLowerCase()) {
    case "0":
    case "off":
    case "false":
    case "no":
      return "off";
    default:
      return "once";
  }
};

/**
 * Resolve pi's compaction.keepRecentTokens from the global agent
 * settings.json so the one-shot trigger fires exactly when older turns
 * would first be swept into summarized history. Read-only and
 * fail-open: any parse error or missing key falls back to `fallback`.
 */
function resolveKeepRecentTokens(fallback: number): number {
  try {
    const cfg = JSON.parse(
      readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
    ) as { compaction?: { keepRecentTokens?: unknown } };
    const krt = cfg?.compaction?.keepRecentTokens;
    if (typeof krt === "number" && Number.isFinite(krt) && krt > 0) return krt;
  } catch {
    /* unreadable settings: keep the fallback */
  }
  return fallback;
}

const LEDGER_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "ledger.jsonl");

/** Resolve tunables: env overrides first, then defaults. */
export function loadOptions(): PiCacheOptions {
  return {
    telemetry: envBool("PI_CACHE_TELEMETRY", true),
    sortTools: envBool("PI_CACHE_SORT_TOOLS", true),
    dedupTools: envBool("PI_CACHE_DEDUP_TOOLS", true),
    advisory: envBool("PI_CACHE_ADVISORY", true),
    ledgerPath: process.env["PI_CACHE_LEDGER"] || LEDGER_DEFAULT,
    // All cache-favoring features are ON by default; set the env var to
    // 0/off/false to disable (e.g. PI_CACHE_SOFT_COMPACT=off).
    autoCompact: envBool("PI_CACHE_AUTO_COMPACT", true),
    cooldownSeconds: parseFloat(process.env["PI_CACHE_COOLDOWN_SECONDS"] ?? "600"),
    minGapSeconds: parseFloat(process.env["PI_CACHE_MIN_GAP_SECONDS"] ?? "240"),
    softCompactMode: parseSoftMode(process.env["PI_CACHE_SOFT_COMPACT"]),
    softCompactMinDeltaTurns: parseInt(process.env["PI_CACHE_SOFT_MIN_DELTA_TURNS"] ?? "1", 10),
    softOnceMinTokens: parseFloat(
      process.env["PI_CACHE_ONCE_MIN_TOKENS"] ??
        String(resolveKeepRecentTokens(20000)),
    ),
    softAutoResume: envBool("PI_CACHE_SOFT_AUTORESUME", true),
  };
}
