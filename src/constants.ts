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
import { homedir } from "node:os";
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
  /** Soft compaction cadence (default auto/repeated; env overrides). */
  softCompactMode: "off" | "auto";
  /** Minimum turns since the last compaction before the soft cadence acts. */
  softCompactMinDeltaTurns: number;
  /**
   * Re-arm trigger (mode "auto"): each time the live context grows back to
   * this many tokens after the previous compaction, fire another fast
   * compaction — the moment older turns would first be swept into
   * summarized history. Natural hysteresis (the compaction drops context
   * below the threshold) keeps the cadence from looping within a turn.
   * Default mirrors pi's keepRecentTokens so every sweep happens exactly
   * as content is about to become history.
   */
  softMinTokens: number;
  /** Persist fast-compacted entries to a temporary store for recovery. */
  compactCapture: boolean;
  /** Owned store root ("~" expanded to the home dir at load time). */
  compactDir: string;
  /** Per-session ring: newest N artifacts kept per session. */
  compactRing: number;
  /** TTL in days before artifacts are pruned. */
  compactTtlDays: number;
  /** Global cap on artifacts across all sessions. */
  compactMaxArtifacts: number;
  /** Per-artifact cap in MiB (overflow records drop trailing entries). */
  compactMaxMb: number;
}

const envBool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

/** parseInt with a guarded default: unset/unparsable values fall back. */
const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Expand a leading "~" to the home dir (used for the compact store). */
const expandHome = (path: string): string => {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
};

const SOFT_DEFAULT: "off" | "auto" = "auto";

/**
 * Parse PI_CACHE_SOFT_COMPACT: "0"/"off"/"false"/"no" disable; "auto"
 * (default) re-arms the fast stub compaction every time live context
 * crosses the threshold again. The legacy "once" value is accepted as an
 * alias for "auto" (the one-shot cadence was removed — with a hard latch
 * the context simply grows back to pi's cold threshold compaction, which
 * runs an LLM summarizer and re-writes the whole prefix).
 */
const parseSoftMode = (raw: string | undefined): "off" | "auto" => {
  if (raw === undefined || raw === "") return SOFT_DEFAULT;
  switch (raw.toLowerCase()) {
    case "0":
    case "off":
    case "false":
    case "no":
      return "off";
    default:
      return "auto";
  }
};

/**
 * Resolve pi's compaction.keepRecentTokens from the global agent
 * settings.json so the re-arm trigger fires exactly when older turns
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
    softMinTokens: parseFloat(
      process.env["PI_CACHE_SOFT_MIN_TOKENS"] ??
        process.env["PI_CACHE_ONCE_MIN_TOKENS"] ??        String(resolveKeepRecentTokens(20000)),
    ),
    // Compacted-entry capture: on by default, strict GC inside the owned
    // root at ~/tmp/pi-cache/compacts (see compactstore.ts).
    compactCapture: envBool("PI_CACHE_COMPACT_CAPTURE", true),
    compactDir: expandHome(process.env["PI_CACHE_COMPACT_DIR"] ?? "~/tmp/pi-cache/compacts"),
    compactRing: envInt("PI_CACHE_COMPACT_RING", 3),
    compactTtlDays: envInt("PI_CACHE_COMPACT_TTL_DAYS", 7),
    compactMaxArtifacts: envInt("PI_CACHE_COMPACT_MAX_ARTIFACTS", 200),
    compactMaxMb: envInt("PI_CACHE_COMPACT_MAX_MB", 16),
  };
}
