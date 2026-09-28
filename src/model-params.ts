/**
 * pi-cache — fresh OpenRouter model parameters.
 *
 * One responsibility: turn a live OpenRouter model id into the cache cost
 * rates the compaction-economics model prices against, by always attempting
 * a fresh pull of OpenRouter's public model list and falling back to the
 * last-good snapshot only when the pull is inaccessible. The snapshot lives
 * in memory for synchronous reads (the pressure decision never awaits) and
 * is persisted through `ParamsStore` so last-good survives a restart. The
 * class never throws into a caller; every failure degrades to the previous
 * values and the caller defers to pi's own model rates.
 *
 * TTL is not exposed by OpenRouter, so it is owned by `ModelTtl` instead.
 */

import type { CostRates } from "./economics.ts";
import type { ParamsStore, PersistedModel, PersistedOverride, PersistedRates, PersistedSnapshot } from "./params-store.ts";

/** The slice of a fetch Response the parser needs (injectable for tests). */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** Injectable fetch seam (defaults to the process `fetch`). */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface ModelParamsOptions {
  /** Last-good persistence; absent disables disk (memory-only). */
  store?: ParamsStore;
  /** Injectable fetch for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** In-memory freshness bound before a background re-pull (default 5 min). */
  maxAgeMs?: number;
  /** Minimum gap between failed re-pull attempts (default 60 s). */
  retryMs?: number;
  /** API base (default `https://openrouter.ai/api/v1`). */
  baseUrl?: string;
  /** Fetch abort timeout (default 5 s). */
  timeoutMs?: number;
}

export interface RefreshResult {
  ok: boolean;
  models: number;
}

export class OpenRouterModelParams {
  private static readonly DEFAULTS = {
    maxAgeMs: 300_000,
    retryMs: 60_000,
    baseUrl: "https://openrouter.ai/api/v1",
    timeoutMs: 5_000,
  };
  private static readonly SCHEMA_VERSION = 1;

  private snapshot: PersistedSnapshot | undefined;
  private inFlight: Promise<RefreshResult> | undefined;
  private lastAttemptAt = 0;

  private readonly store: ParamsStore | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly retryMs: number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: ModelParamsOptions = {}) {
    this.store = opts.store;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init) as Promise<FetchResponseLike>);
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? OpenRouterModelParams.DEFAULTS.maxAgeMs;
    this.retryMs = opts.retryMs ?? OpenRouterModelParams.DEFAULTS.retryMs;
    this.baseUrl = (opts.baseUrl ?? OpenRouterModelParams.DEFAULTS.baseUrl).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? OpenRouterModelParams.DEFAULTS.timeoutMs;
    this.snapshot = this.store?.load();
  }

  /**
   * pi-shaped per-million rates for one model, selecting the request-wide
   * override tier for `tokens` when supplied. Undefined when the model has
   * no usable pricing yet; the caller then falls back to pi's own rates.
   * A missing or stale snapshot kicks one background re-pull.
   */
  ratesFor(modelId: string, tokens?: number): CostRates | undefined {
    if (!modelId) return undefined;
    const model = this.snapshot?.models[modelId];
    if (!model) {
      this.ensure(modelId);
      return undefined;
    }
    this.ensure(modelId);
    const tier = this.tierFor(model, tokens);
    return { input: tier.input, cacheRead: tier.cacheRead, cacheWrite: tier.cacheWrite };
  }

  /** Whether the in-memory snapshot is within the freshness bound. */
  isFresh(): boolean {
    if (!this.snapshot) return false;
    return this.now() - this.snapshot.fetchedAt < this.maxAgeMs;
  }

  /**
   * Trigger a background re-pull when the model is unknown or the snapshot
   * is stale. Debounced by `retryMs` so a failing endpoint is not hammered.
   */
  ensure(modelId: string): void {
    const known = this.snapshot?.models[modelId] !== undefined;
    if (known && this.isFresh()) return;
    if (this.now() - this.lastAttemptAt < this.retryMs) return;
    this.lastAttemptAt = this.now();
    void this.refresh();
  }

  /**
   * Pull the model list fresh and persist it. Never rejects; a failure
   * leaves the previous snapshot in place and resolves `{ok:false}`.
   * Concurrent callers share one in-flight request.
   */
  refresh(): Promise<RefreshResult> {
    if (this.inFlight) return this.inFlight;
    const promise = this.performRefresh();
    this.inFlight = promise;
    void promise.then(() => {
      if (this.inFlight === promise) this.inFlight = undefined;
    });
    return promise;
  }

  /** The one fetch-and-persist attempt; every error is contained. */
  private async performRefresh(): Promise<RefreshResult> {
    try {
      const body = await this.fetchJson(`${this.baseUrl}/models`);
      const models = this.parseSnapshot(body);
      if (Object.keys(models).length === 0) return { ok: false, models: 0 };
      const snapshot: PersistedSnapshot = {
        schemaVersion: OpenRouterModelParams.SCHEMA_VERSION,
        fetchedAt: this.now(),
        models,
      };
      this.snapshot = snapshot;
      this.store?.save(snapshot);
      return { ok: true, models: Object.keys(models).length };
    } catch {
      return { ok: false, models: 0 };
    }
  }

  /** Fetch JSON with an abort timeout; throws on any non-2xx. */
  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`openrouter ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map OpenRouter's `data` array into valid persisted entries. */
  private parseSnapshot(body: unknown): Record<string, PersistedModel> {
    const models: Record<string, PersistedModel> = {};
    const data = (body as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) return models;
    for (const raw of data) {
      const entry = raw as { id?: unknown; pricing?: unknown; context_length?: unknown };
      if (typeof entry.id !== "string") continue;
      const model = this.parseModel(entry.pricing, entry.context_length);
      if (model) models[entry.id] = model;
    }
    return models;
  }

  /** One model's base rates plus any request-wide override tiers. */
  private parseModel(pricing: unknown, contextLength: unknown): PersistedModel | undefined {
    const rates = (pricing ?? {}) as Record<string, unknown>;
    const input = OpenRouterModelParams.toPerMillion(rates.prompt);
    if (input === undefined || input <= 0) return undefined;
    const base: PersistedRates = {
      input,
      cacheRead: OpenRouterModelParams.clampRead(
        OpenRouterModelParams.toPerMillion(rates.input_cache_read) ?? input,
        input,
      ),
      cacheWrite: OpenRouterModelParams.toPerMillion(rates.input_cache_write) ?? 0,
    };
    return {
      base,
      overrides: this.parseOverrides(rates.overrides, input),
      ...(typeof contextLength === "number" && contextLength > 0 ? { contextLength } : {}),
    };
  }

  /** Request-wide tiers; a tier missing a usable prompt rate is dropped. */
  private parseOverrides(raw: unknown, fallbackInput: number): PersistedOverride[] {
    if (!Array.isArray(raw)) return [];
    const overrides: PersistedOverride[] = [];
    for (const item of raw) {
      const tier = (item ?? {}) as Record<string, unknown>;
      const minPromptTokens = Number(tier.min_prompt_tokens);
      const input = OpenRouterModelParams.toPerMillion(tier.prompt) ?? fallbackInput;
      if (!(minPromptTokens > 0) || input <= 0) continue;
      overrides.push({
        minPromptTokens,
        input,
        cacheRead: OpenRouterModelParams.clampRead(
          OpenRouterModelParams.toPerMillion(tier.input_cache_read) ?? input,
          input,
        ),
        cacheWrite: OpenRouterModelParams.toPerMillion(tier.input_cache_write) ?? 0,
      });
    }
    return overrides;
  }

  /** The highest-minimum tier not exceeding `tokens`, else the base tier. */
  private tierFor(model: PersistedModel, tokens?: number): PersistedRates {
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) return model.base;
    let best: PersistedOverride | undefined;
    for (const override of model.overrides) {
      if (tokens >= override.minPromptTokens && (!best || override.minPromptTokens > best.minPromptTokens)) {
        best = override;
      }
    }
    return best ?? model.base;
  }

  /** USD-per-token string/number to per-million; undefined when unusable. */
  private static toPerMillion(value: unknown): number | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const parsed = typeof value === "number" ? value : Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return parsed * 1_000_000;
  }

  /** A cache-read rate never exceeds the input rate. */
  private static clampRead(read: number, input: number): number {
    return Math.max(0, Math.min(input, read));
  }
}
