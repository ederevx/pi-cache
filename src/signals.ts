/**
 * pi-cache — live session signals.
 *
 * One responsibility: read the per-request live state (model cost rates,
 * provider cache lifetime, session identity) out of pi's handler context
 * and assemble the `AutocompactSignal` the auto-compaction controller
 * reads. It owns only option values; each collaborator's state is read
 * through the injected `SignalSources` seam, so no cross-owner state is
 * reached directly.
 */

import type { CostRates } from "./economics.ts";
import type { AutocompactSignal } from "./autocompact.ts";

/** The model fields pi exposes on the handler context. */
export interface ModelView {
  id?: string;
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
}

/** The collaborator state the signals read, owned by their own classes. */
export interface SignalSources {
  lastUsage(): { input: number; cacheRead: number; cacheWrite: number } | undefined;
  msSinceLastTurn(): number;
  headChurn(): number;
  affinityRotated(): boolean;
}

export class SessionSignals {
  constructor(
    private readonly opts: SessionSignalsOptions,
    private readonly sources: SignalSources,
  ) {}

  /** Provider cache lifetime (ms) from the model's promptCache tier. */
  cacheTtlMs(ctx: SessionContextView | undefined): number {
    const retention = this.opts.cacheRetentionLong ? "long" : "short";
    const seconds = ctx?.model?.promptCache?.[retention];
    return typeof seconds === "number" && seconds > 0
      ? seconds * 1000
      : this.opts.fallbackTtlSeconds * 1000;
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
      headChurn: () => this.sources.headChurn(),
      affinityRotated: () => this.sources.affinityRotated(),
      cacheTtlMs: () => this.cacheTtlMs(ctx),
      costRates: () => this.costRates(ctx),
    };
  }
}
