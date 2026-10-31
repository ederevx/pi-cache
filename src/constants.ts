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

import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { UserSettingsStore, type UserSettings } from "./user-settings.ts";
import type { TtlProfile } from "./model-ttl.ts";

/** Runtime data directory for pi-cache's ledger, backups, and settings. */
const LEDGER_DIR_NAME = ".pi-cache";
const LEDGER_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "ledger.jsonl");
const SETTINGS_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "settings.json");
const BACKUP_DEFAULT = join(getAgentDir(), LEDGER_DIR_NAME, "backups");
/** Default model-list endpoint (OpenRouter publishes its pricing there). */
const DEFAULT_MODEL_PARAMS_URL = "https://openrouter.ai/api/v1/models";

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
  /** Derive the chat-completions prompt_cache_key from the prefix head (default off). */
  sharedKey: boolean;
  /** Force pi's cache-warming decision to "warm" (default off). */
  forceWarm: boolean;
  /** Render the miss taxonomy in /cache-stats (default on). */
  missDiagnosis: boolean;
  /** Log compaction advisories (observational only). */
  advisory: boolean;
  /** Absolute path of the usage ledger (baseline header plus row window). */
  ledgerPath: string;
  /** Retained ledger rows before the oldest are folded into the lifetime
   *  baseline (<= 0 = unbounded). */
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
  /** Allow a mid-run compaction when pressure is saturated and the
   *  window is at least half full (default on). */
  midterm: boolean;
  /** Minimum seconds between automatic compactions. */
  cooldownSeconds: number;
  /** Coldness at/below which a non-churned cache is warm (0..1). */
  pressureColdFloor: number;
  /** Fallback provider cache lifetime (s) when the model declares none. */
  cacheTtlSeconds: number;
  /** Absolute path of the last-good model-parameter snapshot. */
  modelParamsPath: string;
  /** Model-list endpoint the parameters are pulled from (an empty value
   *  disables fetched parameters, leaving pi's own rates authoritative). */
  modelParamsUrl: string;
  /** In-memory freshness bound before a background re-pull (ms). */
  modelParamsMaxAgeMs: number;
  /** Minimum gap between failed re-pull attempts (ms). */
  modelParamsRetryMs: number;
  /** Model-list fetch abort timeout (ms). */
  modelParamsTimeoutMs: number;
  /** Maximum valid model entries loaded from the persisted snapshot. */
  modelParamsMaxModels: number;
  /** Provider cache-lifetime profiles, first matching substring wins. */
  cacheTtlProfiles: readonly TtlProfile[];
  /** True when `PI_CACHE_RETENTION=long` selects the long cache tier. */
  cacheRetentionLong: boolean;
  /** Fast cache-aware compaction override (default on; /cache-settings switch). */
  fastCompact: boolean;
  /** Separate fast branch-summary override (default on; its own switch). */
  fastBranchSummary: boolean;
  /** Append a deterministic dropped-span digest after the fast stub (default on). */
  fastDigest: boolean;
  /** Fast-compaction kept-window cap as a multiple of pi's keep-recent
   *  budget (default 4); a lone oversized recent entry otherwise survives
   *  every compaction and overflows the provider context. */
  fastKeepRatio: number;
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
  /** Absolute token cap on the degradation onset start (<=0 uncapped). */
  pressureDegradeStartTokens: number;
  /** Absolute token cap on degradation saturation (<=0 uncapped). */
  pressureDegradeFullTokens: number;
  /** Window occupancy percent the midterm gate also requires. */
  midtermMinPercent: number;
}

export class OptionsLoader {
  /**
   * Default cache-lifetime profiles, first matching substring of
   * `${provider} ${modelId}` wins. Values are the documented provider
   * lifetimes (see docs/research/internet-prompt-caching-2026-09-18.md):
   * Anthropic/OpenAI/Kimi/Gemini are published; DeepSeek and GLM publish
   * none, so their values are empirical. DeepSeek sits at 30 min because
   * OpenRouter sticky routing expires after 10 min of inactivity and a
   * host measurement of 19,957 inter-request gaps put hit share at 0.92
   * (5-10 min), 0.55 (30-60 min), and 0.23 (1-4 h).
   */
  private static readonly DEFAULT_TTL_PROFILES: readonly TtlProfile[] = [
    { matches: ["anthropic"], short: 300, long: 3600 },
    { matches: ["openai", "azure"], short: 1800, long: 1800 },
    { matches: ["moonshot", "kimi", "qwen", "alibaba"], short: 300, long: 3600 },
    { matches: ["deepseek"], short: 1800, long: 1800 },
    { matches: ["z-ai", "glm"], short: 120, long: 120 },
    { matches: ["google", "gemini"], short: 300, long: 3600 },
  ];

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
      missDiagnosis: this.envBool("PI_CACHE_MISS_DIAGNOSIS", stored.missDiagnosis ?? true),
      advisory: this.envBool("PI_CACHE_ADVISORY", stored.advisory ?? true),
      ledgerPath: this.env["PI_CACHE_LEDGER"] || LEDGER_DEFAULT,
      ledgerMaxRows: this.envInt("PI_CACHE_LEDGER_MAX_ROWS", 20000),
      backupDir: this.env["PI_CACHE_BACKUP_DIR"] || BACKUP_DEFAULT,
      backupKeep: this.envInt("PI_CACHE_LEDGER_BACKUPS", 3),
      backupTtlDays: this.envInt("PI_CACHE_LEDGER_BACKUP_TTL_DAYS", 7),
      backupMaxMb: this.envInt("PI_CACHE_LEDGER_BACKUP_MAX_MB", 32),
      // Cache-favoring features are ON by default; set the env var to
      // 0/off/false/no to disable. Truthy spellings are 1/true/yes/on.
      autoCompact: this.envBool("PI_CACHE_AUTO_COMPACT", stored.autoCompact ?? true),
      idleTrigger: this.envBool("PI_CACHE_IDLE_TRIGGER", true),
      beforeTurn: this.envBool("PI_CACHE_BEFORE_TURN", true),
      midterm: this.envBool("PI_CACHE_MIDTERM", stored.midterm ?? true),
      cooldownSeconds: this.envFloat("PI_CACHE_COOLDOWN_SECONDS", 600),
      pressureColdFloor: this.envFloat("PI_CACHE_PRESSURE_COLD_FLOOR", 0.2),
      cacheTtlSeconds: this.envFloat("PI_CACHE_TTL_SECONDS", 300),
      modelParamsPath: this.modelParamsPath(),
      modelParamsUrl: (this.env["PI_CACHE_MODEL_PARAMS_URL"] ?? DEFAULT_MODEL_PARAMS_URL).trim(),
      modelParamsMaxAgeMs: this.envInt("PI_CACHE_MODEL_PARAMS_MAX_AGE_MS", 300_000, 0),
      modelParamsRetryMs: this.envInt("PI_CACHE_MODEL_PARAMS_RETRY_MS", 60_000, 0),
      // Node turns a delay outside its signed 32-bit timer range into 1 ms.
      modelParamsTimeoutMs: this.envInt("PI_CACHE_MODEL_PARAMS_TIMEOUT_MS", 5_000, 1, 2_147_483_647),
      modelParamsMaxModels: this.envInt("PI_CACHE_MODEL_PARAMS_MAX_MODELS", 5000, 1),
      cacheTtlProfiles: this.ttlProfiles(),
      cacheRetentionLong: this.env["PI_CACHE_RETENTION"] === "long",
      // Fast compaction: env beats the owned settings switch beats default on.
      fastCompact: this.envBool("PI_CACHE_FAST_COMPACT", stored.fastCompaction ?? true),
      // Branch summaries have their own switch (lossier than compaction).
      fastBranchSummary: this.envBool(
        "PI_CACHE_FAST_BRANCH_SUMMARY",
        stored.fastBranchSummary ?? true,
      ),
      // The digest keeps the dropped span's file/turn record after the
      // stub; enforced for dropped spans of any size.
      fastDigest: this.envBool("PI_CACHE_FAST_DIGEST", stored.fastDigest ?? true),
      fastKeepRatio: this.envFloat("PI_CACHE_FAST_KEEP_RATIO", 4),
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
      // Provisional absolute budgets: a large advertised window would
      // otherwise postpone quality pressure far past the context a model
      // actually holds up on. Independently configurable; <=0 uncaps.
      pressureDegradeStartTokens: this.envInt("PI_CACHE_PRESSURE_DEGRADE_START_TOKENS", 100_000),
      pressureDegradeFullTokens: this.envInt("PI_CACHE_PRESSURE_DEGRADE_FULL_TOKENS", 200_000),
      midtermMinPercent: this.envFloat("PI_CACHE_MIDTERM_MIN_PERCENT", 50),
    };
  }

  /**
   * Provider cache-lifetime profiles: PI_CACHE_TTL_PROFILES replaces the
   * default table whole (unset keeps it, an empty value disables the table so
   * only pi's `promptCache` tier and PI_CACHE_TTL_SECONDS remain, a malformed
   * entry keeps the default table). Grammar: `match[,match...]=short[,long]`
   * entries separated by `;`; an omitted long lifetime reuses the short one.
   */
  private ttlProfiles(): readonly TtlProfile[] {
    const raw = this.env["PI_CACHE_TTL_PROFILES"];
    if (raw === undefined) return OptionsLoader.DEFAULT_TTL_PROFILES;
    if (raw.trim() === "") return [];
    return OptionsLoader.parseTtlProfiles(raw) ?? OptionsLoader.DEFAULT_TTL_PROFILES;
  }

  /** One profile table from its serialized form; undefined when malformed. */
  private static parseTtlProfiles(raw: string): TtlProfile[] | undefined {
    const profiles: TtlProfile[] = [];
    for (const entry of raw.split(";")) {
      const parts = entry.split("=");
      if (parts.length !== 2) return undefined;
      const matches = parts[0].split(",").map((token) => token.trim().toLowerCase());
      if (matches.some((token) => token === "")) return undefined;
      const lifetimes = parts[1].split(",").map((value) => Number(value.trim()));
      if (lifetimes.length < 1 || lifetimes.length > 2) return undefined;
      if (lifetimes.some((seconds) => !Number.isFinite(seconds) || seconds <= 0)) return undefined;
      profiles.push({ matches, short: lifetimes[0], long: lifetimes[1] ?? lifetimes[0] });
    }
    return profiles;
  }

  /** The owned settings file path (env override exists for hermetic tests). */
  private userSettingsPath(): string {
    return this.env["PI_CACHE_SETTINGS"] || SETTINGS_DEFAULT;
  }

  /** The last-good model-parameter snapshot path (env override for tests);
   *  defaults beside the ledger so all pi-cache state stays together. */
  private modelParamsPath(): string {
    const override = this.env["PI_CACHE_MODEL_PARAMS"];
    if (override) return override;
    const ledger = this.env["PI_CACHE_LEDGER"] || LEDGER_DEFAULT;
    return join(dirname(ledger), "model-params.json");
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
      ["missDiagnosis", "PI_CACHE_MISS_DIAGNOSIS"],
      ["advisory", "PI_CACHE_ADVISORY"],
      ["autoCompact", "PI_CACHE_AUTO_COMPACT"],
      ["midterm", "PI_CACHE_MIDTERM"],
      ["fastCompaction", "PI_CACHE_FAST_COMPACT"],
      ["fastBranchSummary", "PI_CACHE_FAST_BRANCH_SUMMARY"],
      ["fastDigest", "PI_CACHE_FAST_DIGEST"],
    ];
    return pins.filter(([id, name]) => this.env[name] !== undefined).map(([id]) => id);
  }

  private envBool(name: string, fallback: boolean): boolean {
    const raw = this.env[name];
    if (raw === undefined) return fallback;
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  }

  /** parseFloat/parseInt with a guarded default: unset/unparsable values
   *  fall back; `parse` selects int or float so one method covers both. */
  private envNumber(name: string, fallback: number, parse: (raw: string) => number): number {
    const raw = this.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = parse(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private envFloat(name: string, fallback: number): number {
    return this.envNumber(name, fallback, parseFloat);
  }

  private envInt(name: string, fallback: number, min?: number, max?: number): number {
    const n = this.envNumber(name, fallback, (raw) => parseInt(raw, 10));
    return (min !== undefined && n < min) || (max !== undefined && n > max) ? fallback : n;
  }
}
