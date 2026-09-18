/**
 * pi-cache — pi extension entry point.
 *
 * Wire-only module, matching the house pattern (a local extension/index.ts):
 * construct collaborators, register hooks and the command, and nothing
 * else. All logic lives in single-responsibility classes owned here; no
 * module-global mutable state.
 *
 * Hooks:
 *   message_end            — record assistant usage in the ledger
 *   before_provider_headers— observe session-affinity header stability
 *   before_provider_request— opt-in tools sort/dedup + head-churn watch
 *   turn_end               — turn bookkeeping for auto/soft compaction
 *   agent_settled          — cadence point, two listeners: cache-aware
 *                            auto-compact (cold window; soft-off fallback)
 *                            and soft compaction (fast stub, repeated
 *                            cadence)
 *   session_before_compact — two listeners: warm-cache advisory, then the
 *                            soft-compaction proposal (last-truthy wins)
 *   session_compact        — compaction telemetry
 *
 * Command:
 *   /cache-stats           — session cache-ratio, churn, affinity, compactions
 *
 * Config: PI_CACHE_* environment variables only (no config JSON — house
 * rule); durable telemetry to the `.pi-cache/` dot-dir under the agent
 * dir (see constants.ts).
 */

import { loadOptions } from "./constants.ts";
import { CacheLedger } from "./ledger.ts";
import { FileRecordSink } from "./sink.ts";
import { PrefixNormalizer } from "./normalizer.ts";
import { CompactionAdvisor } from "./compaction.ts";
import { AffinityObserver } from "./affinity.ts";
import { AutocompactController } from "./autocompact.ts";
import { SoftCompactionController } from "./softcompact.ts";
import { SettingsPresenter } from "./settings.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Normalize unknown handler payload shapes with a safe local view. */
type ModelView = { model?: { id?: string } | undefined } | undefined;

export default function piCacheExtension(pi: ExtensionAPI): void {
  const opts = loadOptions();
  const ledger = new CacheLedger(new FileRecordSink(opts.ledgerPath), opts.telemetry);
  const normalizer = new PrefixNormalizer({
    sortTools: opts.sortTools,
    dedupTools: opts.dedupTools,
  });
  const advisor = new CompactionAdvisor({ enabled: opts.advisory });
  const affinity = new AffinityObserver();
  const autocompact = new AutocompactController({
    enabled: opts.autoCompact,
    cooldownSeconds: opts.cooldownSeconds,
    minGapSeconds: opts.minGapSeconds,
  });
  const softcompact = new SoftCompactionController({
    mode: opts.softCompactMode,
    minDeltaTurns: opts.softCompactMinDeltaTurns,
    minTokens: opts.softMinTokens,
  });
  const settingsPresenter = new SettingsPresenter();

  pi.on("message_end", async (event, ctx) => {
    try {
      const message = event.message;
      if (message?.role === "assistant") {
        const model = (ctx as ModelView)?.model?.id ?? "session";
        ledger.record(message.usage, model);
      }
    } catch {
      /* never break the turn */
    }
  });

  pi.on("before_provider_request", async (event) => {
    try {
      return normalizer.normalize(event.payload);
    } catch {
      return event.payload;
    }
  });

  pi.on("before_provider_headers", async (event) => {
    try {
      affinity.note(event.headers ?? {});
    } catch {
      /* observational only */
    }
  });

  pi.on("turn_end", async (event) => {
    try {
      autocompact.noteTurn(event.turnIndex);
      softcompact.bumpTurn();
    } catch {
      /* bookkeeping only */
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Listener 1 of 2: cache-aware auto-compaction (cold-window). Runs only
    // as soft cadence's fallback — the two listeners never double-fire
    // (soft "off" <=> auto active, by mode). agent_settled is the
    // guaranteed-idle point (no retry or output pending), so
    // compact() cannot abort live work here.
    try {
      if (!(opts.autoCompact && opts.softCompactMode === "off")) return;
      const usage = ctx.getContextUsage?.();
      const verdict = autocompact.decide(usage?.percent, ledger);
      if (verdict.shouldCompact) {
        ctx.compact?.({
          onComplete: () => autocompact.markCompacted(),
          onError: () =>
            pi.appendEntry("pi-cache-advisory", { message: "auto-compact failed" }),
        });
      }
    } catch {
      /* automatic control must never break a turn */
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Listener 2 of 2: soft compaction cadence. mode "auto" (default):
    // re-arm every time the live context has grown back to the threshold
    // since the last compaction. Each pass replaces only the newest
    // uncached delta with the SAME byte-stable stub (pi's own cut point),
    // so the [stable head][stub] prefix stays byte-identical across all
    // compactions and keeps hitting the provider cache, while input stays
    // bounded near 2x keepRecentTokens instead of growing into pi's cold
    // threshold compaction (LLM summarizer, full-prefix re-write).
    try {
      if (opts.softCompactMode === "off") return;
      // Context size signal: the re-arm trigger fires right when older
      // turns are about to become summarized history.
      const contextTokens = ctx.getContextUsage?.()?.tokens;
      if (softcompact.shouldTrigger(opts.softCompactMode, contextTokens)) {
        softcompact.markTriggered();
        ctx.compact?.({
          onError: () => {
            // If compact() failed before the hook ran, release the armed
            // trigger so no later (user) compaction gets a stale override.
            softcompact.clearTrigger();
            try { pi.appendEntry("pi-cache-advisory", { message: "soft-compact failed" }); } catch { /* never break a turn */ }
          },
        });
      }
    } catch {
      /* automatic control must never break a turn */
    }
  });

  pi.on("session_before_compact", async (event) => {
    // Listener 1 of 2: warm-cache advisory (observational only). Returns
    // nothing, so the proposal listener's result below is preserved.
    try {
      const tip = advisor.suggest(
        ledger.totals(),
        event.preparation.messagesToSummarize.length,
        event.preparation.tokensBefore,
      );
      if (tip) pi.appendEntry("pi-cache-advisory", { message: tip });
    } catch {
      /* never break compaction */
    }
  });

  pi.on("session_before_compact", async (event) => {
    // Listener 2 of 2: soft-compaction proposal. Override ONLY compactions
    // we triggered (ours via ctx.compact(), or pi's own threshold/overflow
    // compaction when it lands while the trigger is armed); built-in
    // compactions we did not arm pass through untouched. Peek here;
    // propose() is the single consumer of the flag.
    try {
      if (!softcompact.isTriggered()) return;
      const proposal = await softcompact.propose({
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      });
      if (!proposal) return; // fail-open: pi's default summarization runs
      return { compaction: proposal };
    } catch {
      /* never break compaction */
    }
  });

  pi.on("session_compact", async (event) => {
    try {
      softcompact.recordCompaction();
      if (event.compactionEntry) {
        pi.appendEntry("pi-cache-compaction", {
          keptEntryId: event.compactionEntry.firstKeptEntryId,
          tokensBefore: event.compactionEntry.tokensBefore,
          fromExtension: event.compactionEntry.fromHook,
        });
      }
    } catch {
      /* telemetry only */
    }
  });

  pi.registerCommand("cache-settings", {
    description: "List pi-cache options in the settings-UI layout",
    handler: async (_args, ctx) => {
      try {
        settingsPresenter.present(opts, ctx.ui, ctx.mode);
      } catch {
        console.error("pi-cache: could not render settings");
      }
    },
  });

  pi.registerCommand("cache-stats", {
    description: "Show pi-cache usage, cache ratio, churn, affinity, compactions",
    handler: async (_args, ctx) => {
      const base = ledger.summary();
      const churn = normalizer.churn();
      const line = churn > 0 ? `${base}, head churn ${churn}` : base;
      const text = `${line}, ${affinity.status()}, compactions ${softcompact.stats().compactions}`;
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