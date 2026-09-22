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
 *   turn_end                 — reconcile landed warm refreshes + turn
 *                              bookkeeping for auto-compaction
 *   cache_warming_decision   — observe pi's warm intent and reconcile the
 *                              persisted cache_warm entries
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
 *   /cache-settings          — two-column switch/option editor
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
import { CacheEconomics } from "./economics.ts";
import { ContextDegradation } from "./context-degradation.ts";
import { FastCompactionController } from "./fastcompact.ts";
import { SettingsSwitchBoard } from "./settings-switch.ts";
import { SessionSignals, type SessionContextView } from "./signals.ts";
import { CompactionGate } from "./compaction-gate.ts";
import { CompactionRequest } from "./compaction-request.ts";
import { CompactionTrigger } from "./compaction-trigger.ts";
import { IdleTrigger } from "./idle-trigger.ts";
import { BeforeTurnTrigger } from "./before-turn-trigger.ts";
import { WarmingObserver } from "./warming-observer.ts";
import { UserSettingsStore } from "./user-settings.ts";
import { SettingsPresenter } from "./settings.ts";
import { CacheStatsPresenter } from "./stats.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";

export default function piCacheExtension(pi: ExtensionAPI): void {
  const opts = new OptionsLoader().load();
  // Sweep stale atomic-write temp files before the ledger/settings are read.
  // The settings file may live outside the ledger dir (PI_CACHE_SETTINGS),
  // so both directories are swept; sweeping one dir twice is a harmless
  // no-op for the second call.
  const sweeper = new TempSweeper();
  sweeper.sweep(dirname(opts.ledgerPath));
  sweeper.sweep(dirname(opts.settingsPath));
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
  const sessionPinner = new SessionPinner(opts.pinSession);
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
    minTokens: opts.pressureMinTokens,
    pressure,
  });
  const settingsStore = new UserSettingsStore(opts.settingsPath);
  const settingsPresenter = new SettingsPresenter();
  const statsPresenter = new CacheStatsPresenter();
  const switchBoard = new SettingsSwitchBoard(
    ledger,
    normalizer,
    sessionPinner,
    advisor,
    autocompact,
    fastcompact,
    settingsStore,
  );

  const warming = new WarmingObserver();

  const signals = new SessionSignals(
    {
      cacheRetentionLong: opts.cacheRetentionLong,
      fallbackTtlSeconds: opts.cacheTtlSeconds,
    },
    {
      lastUsage: () => ledger.lastUsage(),
      msSinceLastTurn: () => ledger.msSinceLastTurn(),
      msSinceLastWarm: () => warming.msSinceLastWarm(),
      headChurn: () => normalizer.churn(),
      affinityRotated: () => affinity.rotated(),
    },
  );

  // Compaction is triggered from three points through one coordinator: the
  // settled run end, the TTL idle timer, and a cold before-turn prompt. The
  // gate sizes them to one per idle window; the request makes ctx.compact()
  // awaitable so the before-turn path can defer the prompt.
  const gate = new CompactionGate();
  const compactionRequest = new CompactionRequest(() => {
    try {
      pi.appendEntry("pi-cache-advisory", { message: "auto-compact failed" });
    } catch {
      /* an async compact callback must never break the process */
    }
  });
  const compactionTrigger = new CompactionTrigger<ExtensionContext>({
    shouldCompact: (ctx) =>
      autocompact.decide(
        ctx.getContextUsage?.(),
        signals.for(ctx as unknown as SessionContextView),
      ).shouldCompact,
    keyOf: (ctx) => `${signals.sessionIdOf(ctx)}:${ledger.lastRowId() ?? "none"}`,
    gate,
    request: compactionRequest,
  });
  const idleTrigger = new IdleTrigger<ExtensionContext>({
    isEnabled: () => autocompact.enabled && opts.idleTrigger,
    isIdle: (ctx) => ctx.isIdle?.() === true,
    idleMs: () => signals.msSinceCacheTouch(),
    ttlMs: (ctx) => signals.cacheTtlMs(ctx as unknown as SessionContextView),
    compact: (ctx) => compactionTrigger.tryCompact(ctx),
  });
  const beforeTurn = new BeforeTurnTrigger<
    ExtensionContext,
    { streamingBehavior?: string; source?: string }
  >({
    isEnabled: () => autocompact.enabled && opts.beforeTurn,
    eligible: (event) => event?.streamingBehavior === undefined && event?.source !== "extension",
    shouldCompact: (ctx) => compactionTrigger.shouldCompact(ctx),
    compact: (ctx) => compactionTrigger.tryCompact(ctx),
    disarmIdle: () => idleTrigger.disarm(),
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      gate.reset();
      idleTrigger.disarm();
      warming.reconcile(ctx);
      ledger.useSession(signals.sessionIdOf(ctx));
      idleTrigger.arm(ctx);
    } catch {
      /* telemetry only */
    }
  });

  pi.on("message_end", async (event, ctx) => {
    try {
      const message = event.message;
      if (message?.role === "assistant") {
        const model = (ctx as SessionContextView | undefined)?.model?.id ?? "session";
        ledger.record(message.usage, model, signals.sessionIdOf(ctx));
      }
    } catch {
      /* never break the turn */
    }
  });

  pi.on("before_provider_request", async (event) => {
    try {
      sessionPinner.propose(event.payload);
      return normalizer.normalize(event.payload);
    } catch {
      return event.payload;
    }
  });

  pi.on("before_provider_headers", async (event) => {
    try {
      sessionPinner.apply(event.headers ?? {});
      affinity.note(event.headers ?? {});
    } catch {
      /* observational only */
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      warming.reconcile(ctx);
      autocompact.noteTurn(event.turnIndex);
    } catch {
      /* bookkeeping only */
    }
  });

  pi.on("input", async (event, ctx) => {
    // Before-turn trigger: a cold, idle prompt is deferred by awaiting
    // compaction here; pi awaits input handlers before it builds the turn, so
    // the prompt then continues with the compacted context. Reconcile the
    // warm tail first so the decision sees a refresh that landed while idle.
    try {
      warming.reconcile(ctx);
      await beforeTurn.handle(event, ctx);
    } catch {
      /* fail-open: never block the prompt */
    }
  });

  pi.on("agent_start", async () => {
    // A run started: the idle timer is no longer relevant.
    idleTrigger.disarm();
  });

  pi.on("cache_warming_decision", async (event, ctx) => {
    // Observational: a warm refresh resets the provider cache TTL, so the
    // idle trigger must not compact a cache pi just kept alive. The decision
    // is only the intent; reconcile the persisted entries first so a refresh
    // that already landed wins, then record the new intent.
    try {
      warming.reconcile(ctx);
      warming.noteDecision(event?.action);
    } catch {
      /* observational only */
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Cache-aware auto-compaction (default on). agent_settled is the
    // guaranteed-idle point (no retry or output pending), so compact()
    // cannot abort live work here. The context gate blends the model
    // context degradation with expected-cost economics (a cold cache or an
    // amortized prefix rewrite), not a raw token-count ramp. Arm the TTL
    // timer so a session that then sits idle still compacts when the cache
    // expires.
    try {
      warming.reconcile(ctx);
      if (!autocompact.enabled) return;
      void compactionTrigger.tryCompact(ctx);
      idleTrigger.arm(ctx);
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
    // Stop the idle timer first so it cannot fire into a torn-down session,
    // then flush queued appends and bound the ledger file.
    idleTrigger.disarm();
    try {
      await ledger.close();
    } catch {
      /* telemetry must never break shutdown */
    }
  });

  pi.registerCommand("cache-settings", {
    description: "Edit every pi-cache option in place",
    handler: async (_args, ctx) => {
      try {
        await settingsPresenter.present(
          switchBoard.snapshot(),
          ctx.ui,
          ctx.mode,
          (id, value) => {
            const message = switchBoard.set(id, value);
            if (message) ctx.ui?.notify?.(message, "info");
          },
        );
      } catch {
        console.error("pi-cache: could not render settings");
      }
    },
  });

  pi.registerCommand("cache-stats", {
    description: "Show global and session cache stats with live pressure",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage?.();
      const liveSignals = signals.for(ctx as SessionContextView | undefined);
      const livePressure = autocompact.currentPressure(usage, ledger.lastUsage(), liveSignals);
      const text = statsPresenter.render({
        global: ledger.totals(),
        session: ledger.sessionTotals(),
        churn: normalizer.churn(),
        affinity: affinity.status(),
        compactions: autocompact.stats().compactions,
        fastCompactions: fastcompact.stats().compactions,
        fastEnabled: fastcompact.enabled,
        branchEnabled: fastcompact.branchEnabled,
        pressure: livePressure
          ? { pressure: livePressure.pressure, probability: livePressure.probability }
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
