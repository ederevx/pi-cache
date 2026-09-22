/**
 * pi-cache — live session signals.
 *
 * One responsibility: read the per-request live state (model cost rates,
 * provider cache lifetime, session identity) out of pi's handler context
 * and assemble the `AutocompactSignal` the auto-compaction controller
 * reads. It owns only option values; each collaborator's state is read
 * through the injected `SignalSources` seam, so no cross-owner state is
 * reached directly.
 *
 * TTL semantics: `cacheTtlMs` is pi-cache's OWN coldness-ramp input and
 * deliberately diverges from pi's warmer view — an unknown lifetime falls
 * back through the resolver to the static default (so the idle ramp still
 * fires) instead of pi's undefined (no warming). `piTtlMs` reports the
 * pi-native tier-or-undefined value, the authority for anything that must
 * match pi's warmer or answer its warming decisions; use it there, never
 * mix the two.
 */

import type { CostRates } from "./economics.ts";
import type { AutocompactSignal } from "./autocompact.ts";

/** The model fields pi exposes on the handler context. */
export interface ModelView {
  id?: string;
  provider?: string;
  cost?: { input?: number; cacheRead?: number; cacheWrite?: number };
  promptCache?: { short?: number; long?: number };
}

/** The context fields the signals read. */
export interface SessionContextView {
  model?: ModelView;
  sessionManager?: { getSessionId?: () => string };
}

/** Option values the signals own (never read from the environment here). */
export interface SessionSignalsOptions {
  /** True when `PI_CACHE_RETENTION=long` selects the long cache tier. */
  cacheRetentionLong: boolean;
  /** Fallback provider cache lifetime (s) when the model declares none. */
  fallbackTtlSeconds: number;
  /** Optional resolver-backed fallback consulted before the static
   *  `fallbackTtlSeconds` (provider-aware TTLs); returning undefined keeps
   *  the old static fallback, so callers without a resolver are unchanged. */
  fallbackTtlSecondsOf?: (ctx: SessionContextView | undefined) => number | undefined;
  /** Whether the last applied request ran on the long retention tier;
   *  consulted before the static env-mirror flag so TTL-tier selection
   *  follows the wire when a per-request override is active. */
  retentionLongOf?: () => boolean | undefined;
}

/** The collaborator state the signals read, owned by their own classes. */
export interface SignalSources {
  lastUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined;
  msSinceLastTurn(): number;
  headChurn(): number;
  /** Milliseconds since pi last warmed the cache, when observed. */
  msSinceLastWarm?(): number | undefined;
}

export class SessionSignals {
  constructor(
    private readonly opts: SessionSignalsOptions,
    private readonly sources: SignalSources,
  ) {}

  /**
   * pi's own view of the provider cache lifetime (ms): the model's
   * promptCache tier for the effective retention, or undefined exactly
   * when pi's warmer treats it as unknown and does not schedule. The
   * single source for warming decisions; never feed the fallback here.
   */
  piTtlMs(ctx: SessionContextView | undefined): number | undefined {
    const seconds = this.tierSeconds(ctx);
    return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
  }

  /**
   * pi-cache's coldness-ramp input: the pi tier when declared, else the
   * resolved fallback (provider-aware resolver, then the static default)
   * so the idle ramp still fires for providers pi has no tier for.
   */
  cacheTtlMs(ctx: SessionContextView | undefined): number {
    const seconds = this.tierSeconds(ctx);
    if (typeof seconds === "number" && seconds > 0) return seconds * 1000;
    const resolved = this.opts.fallbackTtlSecondsOf?.(ctx);
    return (resolved ?? this.opts.fallbackTtlSeconds) * 1000;
  }

  /** The model's tier seconds for the effective retention (long wins when
   *  the per-request override ran, else the env-mirror flag). */
  private tierSeconds(ctx: SessionContextView | undefined): number | undefined {
    const effective = this.opts.retentionLongOf?.() ?? this.opts.cacheRetentionLong;
    return ctx?.model?.promptCache?.[effective ? "long" : "short"];
  }

  /** Model cache cost rates (per million tokens), when the model declares them. */
  costRates(ctx: SessionContextView | undefined): CostRates | undefined {
    const cost = ctx?.model?.cost;
    if (typeof cost?.input !== "number" || typeof cost?.cacheRead !== "number") {
      return undefined;
    }
    return {
      input: cost.input,
      cacheRead: cost.cacheRead,
      cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : 0,
    };
  }

  /** The live session id the core exposes, or a stable fallback. */
  sessionIdOf(ctx: unknown): string {
    const manager = (ctx as SessionContextView | undefined)?.sessionManager;
    try {
      return manager?.getSessionId?.() ?? "session";
    } catch {
      return "session";
    }
  }

  /** The live session signals the autocompaction decision reads. */
  for(ctx: SessionContextView | undefined): AutocompactSignal {
    return {
      lastUsage: () => this.sources.lastUsage(),
      msSinceLastTurn: () => this.sources.msSinceLastTurn(),
      msSinceCacheTouch: () => this.msSinceCacheTouch(),
      headChurn: () => this.sources.headChurn(),
      cacheTtlMs: () => this.cacheTtlMs(ctx),
      costRates: () => this.costRates(ctx),
    };
  }

  /**
   * Milliseconds since the cache was last touched. A pi warm refresh resets
   * the provider TTL, so the idle ramp must measure from the most recent of
   * the last turn and the last warm; otherwise the idle trigger could compact
   * a cache pi just kept alive.
   */
  msSinceCacheTouch(): number {
    const turn = this.sources.msSinceLastTurn();
    const warm = this.sources.msSinceLastWarm?.();
    return typeof warm === "number" && Number.isFinite(warm) ? Math.min(turn, warm) : turn;
  }
}
