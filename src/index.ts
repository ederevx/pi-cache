/**
 * pi-cache — pi extension entry point.
 *
 * Wire-only module, matching the house-pattern entry-point shape:
 * construct collaborators, register hooks and the command, and nothing
 * else. All logic lives in single-responsibility classes owned here; no
 * module-global mutable state.
 *
 * Hooks:
 *   session_start            — adopt the session id for session stats
 *   message_end              — record assistant usage in the ledger
 *   before_provider_headers  — observe session-affinity header stability
 *   before_provider_request — tools sort/dedup + head-churn watch (+
 *                             provider session-id pin for stateless runs)
 *   turn_end                 — turn bookkeeping for auto-compaction
 *   agent_settled            — cache-aware auto-compaction: a compaction
 *                              pressure draw blending context degradation
 *                              with expected-cost cache economics
 *   session_before_compact   — warm-cache advisory (observational) then,
 *                              when fast compaction is on, the cache-aware
 *                              override that replaces pi's summarizer for
 *                              EVERY compaction reason ("overall")
 *   session_compact          — autocompaction accounting (all sources) +
 *                              telemetry
 *   session_compact_failed   — failure advisory
 *   session_before_tree      — fast cache-aware branch-summary override
 *   session_tree             — branch-summary telemetry
 *   session_shutdown         — flush appends, then bound the ledger
 *
 * Commands:
 *   /cache-stats             — global + session cache stats, live pressure,
 *                              churn, affinity, compactions
 *   /cache-settings          — fast-compaction switches + resolved options
 *
 * Config: PI_CACHE_* environment variables and pi-cache's owned settings
 * JSON (`~/.pi/agent/.pi-cache/settings.json`, toggled by /cache-settings);
 * durable telemetry goes to the `.pi-cache/` dot-dir (see constants.ts).
 */

import { OptionsLoader } from "./constants.ts";
import { CacheLedger } from "./ledger.ts";
import { FileRecordSink } from "./sink.ts";
import { BackupStore } from "./backup-store.ts";
import { TempSweeper } from "./temp-sweep.ts";
import { PrefixNormalizer } from "./normalizer.ts";
import { CompactionAdvisor } from "./compaction.ts";
import { AffinityObserver } from "./affinity.ts";
import { SessionPinner } from "./session-pin.ts";
import { AutocompactController } from "./autocompact.ts";
import { CompactionPressure } from "./pressure.ts";
import { CacheEconomics, type CostRates } from "./economics.ts";
import { ContextDegradation } from "./context-degradation.ts";
import { FastCompactionController } from "./fastcompact.ts";
import { FastSwitchBoard } from "./fast-switch.ts";
import { UserSettingsStore } from "./user-settings.ts";
import { SettingsPresenter } from "./settings.ts";
import { CacheStatsPresenter } from "./stats.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";

/** Normalize unknown handler payload shapes with a safe local view. */
type ModelView = { model?: { id?: string } | undefined } | undefined;

export default function piCacheExtension(pi: ExtensionAPI): void {
  const opts = new OptionsLoader().load();
  // Sweep stale atomic-write temp files before the ledger/settings are read.
  new TempSweeper().sweep(dirname(opts.ledgerPath));
  // Pre-retention backups, bounded by their own ring/TTL/size GC.
  const backups = new BackupStore(opts.backupDir, {
    keep: opts.backupKeep,
    ttlMs: opts.backupTtlDays * 24 * 60 * 60 * 1000,
    maxBytes: opts.backupMaxMb * 1024 * 1024,
  });
  backups.prune();
  const ledger = new CacheLedger(
    new FileRecordSink(opts.ledgerPath, backups),
    opts.telemetry,
    opts.ledgerMaxRows,
  );
  const normalizer = new PrefixNormalizer({
    sortTools: opts.sortTools,
    dedupTools: opts.dedupTools,
  });
  const advisor = new CompactionAdvisor({ enabled: opts.advisory });
  const affinity = new AffinityObserver();
  const sessionPinner = opts.pinSession ? new SessionPinner() : null;
  const economics = new CacheEconomics({
    continuationProbability: opts.pressureContinuation,
    maxRequests: opts.pressureMaxRequests,
    keepFraction: opts.pressureKeepFraction,
  });
  const pressure = new CompactionPressure({
    economics,
    degradation: new ContextDegradation({
      start: opts.pressureDegradeStart,
      full: opts.pressureDegradeFull,
      gamma: opts.pressureDegradeGamma,
    }),
  });
  const fastcompact = new FastCompactionController({
    enabled: opts.fastCompact,
    branchEnabled: opts.fastBranchSummary,
  });
  const autocompact = new AutocompactController({
    enabled: opts.autoCompact,
    cooldownSeconds: opts.cooldownSeconds,
    coldFloor: opts.pressureColdFloor,
    cacheNeutral: opts.fastCompact,
    summaryCost: opts.pressureSummaryCost,
    pressure,
  });
  const settingsStore = new UserSettingsStore(opts.settingsPath);
  const settingsPresenter = new SettingsPresenter();
  const statsPresenter = new CacheStatsPresenter();
  const switchBoard = new FastSwitchBoard(fastcompact, autocompact, settingsStore);

  /** Provider cache lifetime (ms) from the model's promptCache tier. */
  const cacheTtlMs = (ctx: { model?: unknown } | undefined): number => {
    const model = ctx?.model as
      | { promptCache?: { short?: number; long?: number } }
      | undefined;
    const retention = opts.cacheRetentionLong ? "long" : "short";
    const seconds = model?.promptCache?.[retention];
    return typeof seconds === "number" && seconds > 0
      ? seconds * 1000
      : opts.cacheTtlSeconds * 1000;
  };

  /** Model cache cost rates (per million tokens), when the model declares them. */
  const costRates = (ctx: { model?: unknown } | undefined): CostRates | undefined => {
    const cost = (ctx?.model as
      | { cost?: { input?: number; cacheRead?: number; cacheWrite?: number } }
      | undefined)?.cost;
    if (typeof cost?.input !== "number" || typeof cost?.cacheRead !== "number") {
      return undefined;
    }
    return {
      input: cost.input,
      cacheRead: cost.cacheRead,
      cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : 0,
    };
  };

  /** The live session signals the autocompaction decision reads. */
  const autocompactSignals = (ctx: { model?: unknown } | undefined) => ({
    lastUsage: () => ledger.lastUsage(),
    msSinceLastTurn: () => ledger.msSinceLastTurn(),
    headChurn: () => normalizer.churn(),
    affinityRotated: () => affinity.rotated(),
    cacheTtlMs: () => cacheTtlMs(ctx),
    costRates: () => costRates(ctx),
  });

  /** The live session id the core exposes, or a stable fallback. */
  const sessionIdOf = (ctx: unknown): string => {
    const manager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
      ?.sessionManager;
    try {
      return manager?.getSessionId?.() ?? "session";
    } catch {
      return "session";
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      ledger.useSession(sessionIdOf(ctx));
    } catch {
      /* telemetry only */
    }
  });

  pi.on("message_end", async (event, ctx) => {
    try {
      const message = event.message;
      if (message?.role === "assistant") {
        const model = (ctx as ModelView)?.model?.id ?? "session";
        ledger.record(message.usage, model, sessionIdOf(ctx));
      }
    } catch {
      /* never break the turn */
    }
  });

  pi.on("before_provider_request", async (event) => {
    try {
      sessionPinner?.propose(event.payload);
      return normalizer.normalize(event.payload);
    } catch {
      return event.payload;
    }
  });

  pi.on("before_provider_headers", async (event) => {
    try {
      sessionPinner?.apply(event.headers ?? {});
      affinity.note(event.headers ?? {});
    } catch {
      /* observational only */
    }
  });

  pi.on("turn_end", async (event) => {
    try {
      autocompact.noteTurn(event.turnIndex);
    } catch {
      /* bookkeeping only */
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Cache-aware auto-compaction (default on). agent_settled is the
    // guaranteed-idle point (no retry or output pending), so compact()
    // cannot abort live work here. The context gate blends the model
    // context degradation with expected-cost economics (a cold cache or an
    // amortized prefix rewrite), not a raw token-count ramp.
    try {
      if (!opts.autoCompact) return;
      const usage = ctx.getContextUsage?.();
      const verdict = autocompact.decide(usage, autocompactSignals(ctx));
      if (verdict.shouldCompact) {
        ctx.compact?.({
          onError: () =>
            pi.appendEntry("pi-cache-advisory", { message: "auto-compact failed" }),
        });
      }
    } catch {
      /* automatic control must never break a turn */
    }
  });

  pi.on("session_before_compact", async (event) => {
    // One handler, explicit order: the observational warm-cache advisory runs
    // first and never returns, then the fast cache-aware override ("overall")
    // may replace pi's default LLM summarizer for EVERY reason
    // (manual/threshold/overflow) with the byte-stable stub at pi's own cut
    // point. Returning no compaction (disabled, malformed, or any error)
    // leaves pi's summarizer intact.
    try {
      const preparation = event?.preparation;
      if (preparation) {
        const tip = advisor.suggest(
          ledger.totals(),
          preparation.messagesToSummarize.length,
          preparation.tokensBefore,
        );
        if (tip) pi.appendEntry("pi-cache-advisory", { message: tip });
      }
      const proposal = fastcompact.propose(preparation);
      if (!proposal) return;
      return { compaction: proposal };
    } catch {
      /* fail-open: never wedge a compaction */
    }
  });

  pi.on("session_compact", async (event) => {
    try {
      // Autocompaction owns the completed-compaction accounting for EVERY
      // source (our ctx.compact, pi's threshold/overflow, the fast override),
      // so its cooldown and counter track reality.
      autocompact.markCompacted();
      const fromExtension =
        event?.fromExtension === true || event?.compactionEntry?.fromHook === true;
      if (fromExtension) fastcompact.recordCompaction();
      if (event?.compactionEntry) {
        pi.appendEntry("pi-cache-compaction", {
          keptEntryId: event.compactionEntry.firstKeptEntryId,
          tokensBefore: event.compactionEntry.tokensBefore,
          fromExtension,
        });
      }
    } catch {
      /* telemetry only */
    }
  });

  pi.on("session_compact_failed", async (event) => {
    try {
      if (!event?.aborted && event?.errorMessage) {
        pi.appendEntry("pi-cache-advisory", {
          message: `compaction failed: ${event.errorMessage}`,
        });
      }
    } catch {
      /* telemetry only */
    }
  });

  pi.on("session_before_tree", async (event) => {
    // Fast branch-summary override: pi only uses an extension summary when
    // the user asked for one and there are entries to summarize, so the
    // controller mirrors those guards. Returning nothing leaves pi's
    // default branch summarizer intact (fail-open).
    try {
      const preparation = event?.preparation;
      const proposal = fastcompact.proposeBranch(
        preparation?.entriesToSummarize?.length ?? 0,
        preparation?.userWantsSummary === true,
      );
      if (!proposal) return;
      return { summary: { summary: proposal.summary } };
    } catch {
      /* never wedge a navigation */
    }
  });

  pi.on("session_tree", async (event) => {
    try {
      if (event?.summaryEntry) {
        pi.appendEntry("pi-cache-tree", { fromExtension: event.fromExtension === true });
      }
    } catch {
      /* telemetry only */
    }
  });

  pi.on("session_shutdown", async () => {
    // Flush queued appends, then drop rows beyond the retained window and
    // rewrite the file so it cannot grow without limit.
    try {
      await ledger.close();
    } catch {
      /* telemetry must never break shutdown */
    }
  });

  pi.registerCommand("cache-settings", {
    description: "Toggle fast compaction and list pi-cache options",
    handler: async (_args, ctx) => {
      try {
        const selected = await settingsPresenter.choose(
          opts,
          {
            fastCompaction: fastcompact.enabled,
            fastBranchSummary: fastcompact.branchEnabled,
          },
          ctx.ui,
          ctx.mode,
        );
        const message = selected ? switchBoard.toggle(selected) : undefined;
        if (message) ctx.ui?.notify?.(message, "info");
      } catch {
        console.error("pi-cache: could not render settings");
      }
    },
  });

  pi.registerCommand("cache-stats", {
    description: "Show global and session cache stats with live pressure",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage?.();
      const signals = autocompactSignals(ctx);
      const pressure = autocompact.currentPressure(usage, ledger.lastUsage(), signals);
      const text = statsPresenter.render({
        global: ledger.totals(),
        session: ledger.sessionTotals(),
        churn: normalizer.churn(),
        affinity: affinity.status(),
        compactions: autocompact.stats().compactions,
        fastCompactions: fastcompact.stats().compactions,
        fastEnabled: fastcompact.enabled,
        branchEnabled: fastcompact.branchEnabled,
        pressure: pressure
          ? { pressure: pressure.pressure, probability: pressure.probability }
          : undefined,
      });
      // Command output is emitted through ctx (handler return values are
      // discarded by pi); toast in UI mode, fall back to stderr otherwise.
      try {
        ctx.ui?.notify?.(text, "info");
      } catch {
        console.error(text);
      }
    },
  });
}
