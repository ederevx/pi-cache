/**
 * pi-cache — cache/compaction state reader.
 *
 * One responsibility: assemble one draw-free snapshot of the cache and
 * compaction state for a live context, read from each owner (ledger,
 * autocompaction controller, fast compaction, session signals). It owns no
 * state and triggers nothing, so a reporter (the cache_compact tool, or
 * /cache-stats) can describe the situation without perturbing the automatic
 * probabilistic decision.
 */

import type { AutocompactController, ContextUsageLike } from "./autocompact.ts";
import type { FastCompactionController } from "./fastcompact.ts";
import type { CacheLedger, UsageTotals } from "./ledger.ts";
import type { SessionSignals, SessionContextView } from "./signals.ts";

/** The context fields the reader reads (pi's `ExtensionContext` subset). */
export interface CacheStateContext {
  getContextUsage?(): ContextUsageLike | undefined;
}

export interface CacheStateSnapshot {
  global: UsageTotals;
  session: UsageTotals;
  context?: { tokens: number; contextWindow: number; percent: number };
  pressure?: { pressure: number; probability: number };
  autoEnabled: boolean;
  fastEnabled: boolean;
  telemetryEnabled: boolean;
}

export class CacheStateReader {
  constructor(
    private readonly ledger: CacheLedger,
    private readonly autocompact: AutocompactController,
    private readonly fastcompact: FastCompactionController,
    private readonly signals: SessionSignals,
  ) {}

  /** Read one draw-free snapshot for `ctx`. */
  read(ctx: CacheStateContext | undefined): CacheStateSnapshot {
    const usage = ctx?.getContextUsage?.() ?? undefined;
    const signals = this.signals.for(ctx as SessionContextView | undefined);
    const preview = this.autocompact.currentPressure(
      usage,
      this.ledger.lastRequestUsage(),
      signals,
    );
    const context = CacheStateReader.contextOf(usage);
    return {
      global: this.ledger.totals(),
      session: this.ledger.sessionTotals(),
      context,
      pressure: preview ? { pressure: preview.pressure, probability: preview.probability } : undefined,
      autoEnabled: this.autocompact.enabled,
      fastEnabled: this.fastcompact.enabled,
      telemetryEnabled: this.ledger.enabled,
    };
  }

  /** Normalize pi's context usage when it carries positive numbers. */
  private static contextOf(
    usage: ContextUsageLike | undefined,
  ): { tokens: number; contextWindow: number; percent: number } | undefined {
    if (usage === undefined) return undefined;
    const tokens = usage.tokens ?? undefined;
    const contextWindow = usage.contextWindow;
    if (typeof tokens !== "number" || typeof contextWindow !== "number" || contextWindow <= 0) {
      return undefined;
    }
    const percent =
      typeof usage.percent === "number" ? usage.percent : (tokens / contextWindow) * 100;
    return { tokens, contextWindow, percent };
  }
}
