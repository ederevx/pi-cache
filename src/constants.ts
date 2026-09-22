/**
 * pi-cache — options loader and tunables.
 *
 * House style: tunables are centralized here, overridable through
 * PI_CACHE_* environment variables, mirroring the env-var settings idiom
 * common to pi extensions. Durable telemetry, backups, and pi-cache's own
 * user settings live in a hidden dot-directory under the agent dir (see
 * user-settings.ts), house-consistent hidden-dot-dir convention. The
 * loader owns env parsing so no module-level helper reads a global.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { UserSettingsStore, type UserSettings } from "./user-settings.ts";

/** Runtime data directory for pi-cache's ledger, backups, and settings. */
const LEDGER_DIR_NAME = ".pi-cache";
const LEDGER_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "ledger.jsonl");
const SETTINGS_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "settings.json");
const BACKUP_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "backups");

export interface PiCacheOptions {
  /** Whether telemetry is recorded at all. */
  telemetry: boolean;
  /** Exact-schema tool dedup (opt-in, default on). */
  dedupTools: boolean;
  /** Pin a fourth Anthropic breakpoint on stable mid-history (default on). */
  anchor: boolean;
  /** Rewrite cache markers to the long retention tier per request. */
  retentionOverride: boolean;
  /** Canonicalize skill/project listings in the system prompt (default on). */
  canonicalize: boolean;
  /** Derive OpenAI prompt_cache_key from the prefix head (default off). */
  sharedKey: boolean;
  /** Force pi's cache-warming decision to "warm" (default off). */
  forceWarm: boolean;
  /** Log compaction advisories (observational only). */
  advisory: boolean;
  /** Absolute path of the append-only usage ledger. */
  ledgerPath: string;
  /** Retained ledger rows before the oldest are dropped (<= 0 = unbounded). */
  ledgerMaxRows: number;
  /** Directory for pre-retention ledger backups. */
  backupDir: string;
  /** Newest ledger backups retained (ring). */
  backupKeep: number;
  /** Ledger backup TTL in days (0 = no TTL). */
  backupTtlDays: number;
  /** Total ledger backup size cap in MiB (0 = no cap). */
  backupMaxMb: number;
  /** Cache-aware automatic compaction (default on). */
  autoCompact: boolean;
  /** Fire the TTL-expiry compaction while pi is idle (default on). */
  idleTrigger: boolean;
  /** Defer a cold prompt to compact before the turn starts (default on). */
  beforeTurn: boolean;
  /** Minimum seconds between automatic compactions. */
  cooldownSeconds: number;
  /** Coldness at/below which a non-churned cache is warm (0..1). */
  pressureColdFloor: number;
  /** Fallback provider cache lifetime (s) when the model declares none. */
  cacheTtlSeconds: number;
  /** True when `PI_CACHE_RETENTION=long` selects the long cache tier. */
  cacheRetentionLong: boolean;
  /** Fast cache-aware compaction override (default on; /cache-settings switch). */
  fastCompact: boolean;
  /** Separate fast branch-summary override (default on; its own switch). */
  fastBranchSummary: boolean;
  /** Absolute path of pi-cache's owned user-settings JSON. */
  settingsPath: string;
  /** Probabilistic compaction-pressure model tunables. */
  pressureContinuation: number;
  pressureMaxRequests: number;
  pressureKeepFraction: number;
  pressureSummaryCost: number;
  /** Minimum live context tokens before economics pressure may fire. */
  pressureMinTokens: number;
  pressureDegradeStart: number;
  pressureDegradeFull: number;
  pressureDegradeGamma: number;
}

export class OptionsLoader {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Resolve tunables: env overrides first, then owned settings, then defaults. */
  load(): PiCacheOptions {
    const stored: UserSettings = new UserSettingsStore(this.userSettingsPath()).load();
    return {
      telemetry: this.envBool("PI_CACHE_TELEMETRY", stored.telemetry ?? true),
      dedupTools: this.envBool("PI_CACHE_DEDUP_TOOLS", stored.dedupTools ?? true),
      anchor: this.envBool("PI_CACHE_ANCHOR", stored.anchor ?? true),
      retentionOverride: this.envBool(
        "PI_CACHE_RETENTION_OVERRIDE",
        stored.retentionOverride ?? false,
      ),
      canonicalize: this.envBool("PI_CACHE_CANONICALIZE", stored.canonicalize ?? true),
      sharedKey: this.envBool("PI_CACHE_SHARED_KEY", stored.sharedKey ?? false),
      forceWarm: this.envBool("PI_CACHE_FORCE_WARM", stored.forceWarm ?? false),
      advisory: this.envBool("PI_CACHE_ADVISORY", stored.advisory ?? true),
      ledgerPath: this.env["PI_CACHE_LEDGER"] || LEDGER_DEFAULT,
      ledgerMaxRows: this.envInt("PI_CACHE_LEDGER_MAX_ROWS", 20000),
      backupDir: this.env["PI_CACHE_BACKUP_DIR"] || BACKUP_DEFAULT,
      backupKeep: this.envInt("PI_CACHE_LEDGER_BACKUPS", 3),
      backupTtlDays: this.envInt("PI_CACHE_LEDGER_BACKUP_TTL_DAYS", 7),
      backupMaxMb: this.envInt("PI_CACHE_LEDGER_BACKUP_MAX_MB", 32),
      // Cache-favoring features are ON by default; set the env var to
      // 0/off/false to disable.
      autoCompact: this.envBool("PI_CACHE_AUTO_COMPACT", stored.autoCompact ?? true),
      idleTrigger: this.envBool("PI_CACHE_IDLE_TRIGGER", true),
      beforeTurn: this.envBool("PI_CACHE_BEFORE_TURN", true),
      cooldownSeconds: this.envFloat("PI_CACHE_COOLDOWN_SECONDS", 600),
      pressureColdFloor: this.envFloat("PI_CACHE_PRESSURE_COLD_FLOOR", 0.2),
      cacheTtlSeconds: this.envFloat("PI_CACHE_TTL_SECONDS", 300),
      cacheRetentionLong: this.env["PI_CACHE_RETENTION"] === "long",
      // Fast compaction: env beats the owned settings switch beats default on.
      fastCompact: this.envBool("PI_CACHE_FAST_COMPACT", stored.fastCompaction ?? true),
      // Branch summaries have their own switch (lossier than compaction).
      fastBranchSummary: this.envBool(
        "PI_CACHE_FAST_BRANCH_SUMMARY",
        stored.fastBranchSummary ?? true,
      ),
      settingsPath: this.userSettingsPath(),
      // Compaction pressure: expected-cost economics (write amortization
      // over the expected remaining requests) composed with context
      // degradation (the onset where long-context quality starts to fall).
      // The horizon is `1 / (1 - continuation)` capped at maxRequests;
      // keepFraction estimates the retained suffix a compaction rewrites;
      // summaryCost is zero under fast compaction.
      pressureContinuation: this.envFloat("PI_CACHE_PRESSURE_CONTINUATION", 0.15),
      pressureMaxRequests: this.envFloat("PI_CACHE_PRESSURE_MAX_REQUESTS", 8),
      pressureKeepFraction: this.envFloat("PI_CACHE_PRESSURE_KEEP_FRACTION", 0.2),
      pressureSummaryCost: this.envFloat("PI_CACHE_PRESSURE_SUMMARY_COST", 0),
      pressureMinTokens: this.envInt("PI_CACHE_PRESSURE_MIN_TOKENS", 50_000),
      pressureDegradeStart: this.envFloat("PI_CACHE_PRESSURE_DEGRADE_START", 0.5),
      pressureDegradeFull: this.envFloat("PI_CACHE_PRESSURE_DEGRADE_FULL", 0.85),
      pressureDegradeGamma: this.envFloat("PI_CACHE_PRESSURE_DEGRADE_GAMMA", 2),
    };
  }

  /** The owned settings file path (env override exists for hermetic tests). */
  private userSettingsPath(): string {
    return this.env["PI_CACHE_SETTINGS"] || SETTINGS_DEFAULT;
  }

  /**
   * Row ids whose PI_CACHE_* env var is present: env beats the stored
   * settings on every restart, so the /cache-settings surface marks those
   * rows pinned instead of letting a toggle silently lose.
   */
  envPinnedIds(): string[] {
    const pins: Array<[string, string]> = [
      ["telemetry", "PI_CACHE_TELEMETRY"],
      ["dedupTools", "PI_CACHE_DEDUP_TOOLS"],
      ["anchor", "PI_CACHE_ANCHOR"],
      ["retentionOverride", "PI_CACHE_RETENTION_OVERRIDE"],
      ["canonicalize", "PI_CACHE_CANONICALIZE"],
      ["sharedKey", "PI_CACHE_SHARED_KEY"],
      ["forceWarm", "PI_CACHE_FORCE_WARM"],
      ["advisory", "PI_CACHE_ADVISORY"],
      ["autoCompact", "PI_CACHE_AUTO_COMPACT"],
      ["fastCompaction", "PI_CACHE_FAST_COMPACT"],
      ["fastBranchSummary", "PI_CACHE_FAST_BRANCH_SUMMARY"],
    ];
    return pins.filter(([id, name]) => this.env[name] !== undefined).map(([id]) => id);
  }

  private envBool(name: string, fallback: boolean): boolean {
    const raw = this.env[name];
    if (raw === undefined) return fallback;
    return raw === "1" || raw === "true" || raw === "yes";
  }

  /** parseFloat with a guarded default: unset/unparsable values fall back. */
  private envFloat(name: string, fallback: number): number {
    const raw = this.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  /** parseInt with a guarded default: unset/unparsable values fall back. */
  private envInt(name: string, fallback: number): number {
    const raw = this.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  }
}
