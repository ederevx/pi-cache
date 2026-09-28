/**
 * pi-cache — persisted OpenRouter model-parameter snapshot.
 *
 * One responsibility: own the on-disk last-good model-parameter document —
 * validate it on load and land it atomically on save, so a model-parameter
 * pull that never reaches OpenRouter still has the previous values to fall
 * back to across a restart. Never throws into a caller; a missing, corrupt,
 * or partial document degrades to `undefined`/a dropped entry.
 */

import { readFileSync } from "node:fs";
import { AtomicFile } from "./atomic-file.ts";

/** Per-million cost rates as persisted. */
export interface PersistedRates {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One request-wide pricing tier, selected by minimum prompt tokens. */
export interface PersistedOverride extends PersistedRates {
  minPromptTokens: number;
}

/** One model's persisted parameters. */
export interface PersistedModel {
  base: PersistedRates;
  overrides: PersistedOverride[];
  contextLength?: number;
}

/** The persisted document schema. */
export interface PersistedSnapshot {
  schemaVersion: number;
  fetchedAt: number;
  models: Record<string, PersistedModel>;
}

export class ParamsStore {
  private static readonly SCHEMA_VERSION = 1;
  private static readonly MODE = 0o600;
  private static readonly MAX_MODELS = 5000;

  constructor(private readonly path: string) {}

  /** The last-good snapshot, or undefined when absent or unusable. */
  load(): PersistedSnapshot | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PersistedSnapshot>;
      return this.validate(parsed);
    } catch {
      return undefined;
    }
  }

  /** Atomically persist a snapshot; a failed write is swallowed. */
  save(snapshot: PersistedSnapshot): void {
    try {
      AtomicFile.write(this.path, JSON.stringify(snapshot), ParamsStore.MODE);
    } catch {
      /* last-good persistence is best-effort */
    }
  }

  /** A structurally valid snapshot with every malformed entry dropped. */
  private validate(parsed: Partial<PersistedSnapshot> | undefined): PersistedSnapshot | undefined {
    if (!parsed || typeof parsed.fetchedAt !== "number" || !parsed.models) return undefined;
    const models: Record<string, PersistedModel> = {};
    let count = 0;
    for (const [id, raw] of Object.entries(parsed.models)) {
      if (count >= ParamsStore.MAX_MODELS) break;
      const model = this.validateModel(raw);
      if (model) {
        models[id] = model;
        count++;
      }
    }
    return { schemaVersion: ParamsStore.SCHEMA_VERSION, fetchedAt: parsed.fetchedAt, models };
  }

  /** One model entry: a valid base plus any valid override tiers. */
  private validateModel(raw: unknown): PersistedModel | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const candidate = raw as Partial<PersistedModel>;
    const base = this.validateRates(candidate.base);
    if (!base) return undefined;
    const overrides: PersistedOverride[] = [];
    for (const override of candidate.overrides ?? []) {
      const rates = this.validateRates(override);
      if (rates && typeof override.minPromptTokens === "number" && override.minPromptTokens > 0) {
        overrides.push({ ...rates, minPromptTokens: override.minPromptTokens });
      }
    }
    return {
      base,
      overrides,
      ...(typeof candidate.contextLength === "number" && candidate.contextLength > 0
        ? { contextLength: candidate.contextLength }
        : {}),
    };
  }

  /** Rates must be finite and non-negative, with a positive input rate. */
  private validateRates(raw: unknown): PersistedRates | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const rates = raw as Partial<PersistedRates>;
    if (!ParamsStore.isRate(rates.input) || rates.input <= 0) return undefined;
    if (!ParamsStore.isRate(rates.cacheRead) || !ParamsStore.isRate(rates.cacheWrite)) return undefined;
    return { input: rates.input, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite };
  }

  /** A finite, non-negative number. */
  private static isRate(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
}
