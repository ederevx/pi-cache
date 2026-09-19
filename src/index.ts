/**
 * pi-cache — pi extension entry point.
 *
 * Wire-only module, matching the house-pattern entry-point shape:
 * construct collaborators, register hooks and the command, and nothing
 * else. All logic lives in single-responsibility classes owned here; no
 * module-global mutable state.
 *
 * Hooks:
 *   message_end              — record assistant usage in the ledger
 *   before_provider_headers  — observe session-affinity header stability
 *   before_provider_request — tools sort/dedup + head-churn watch (+
 *                             provider session-id pin for stateless runs)
 *   turn_end                 — turn bookkeeping for auto-compaction
 *   agent_settled            — cache-aware auto-compaction: compact only
 *                              in a cold window (provider cache already
 *                              lost) or when the prefix head churns /
 *                              affinity rotates; pi's own normal
 *                              summarizer compaction runs unchanged
 *   session_before_compact   — warm-cache advisory (observational only;
 *                              never alters or cancels compaction)
 *   session_compact          — compaction telemetry
 *
 * Command:
 *   /cache-stats             — session cache-ratio, churn, affinity
 *   /cache-settings          — resolved PI_CACHE_* options
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
import { SessionPinner } from "./session-pin.ts";
import { AutocompactController } from "./autocompact.ts";
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
  const sessionPinner = opts.pinSession ? new SessionPinner() : null;
  const autocompact = new AutocompactController({
    enabled: opts.autoCompact,
    cooldownSeconds: opts.cooldownSeconds,
    minGapSeconds: opts.minGapSeconds,
  });
  const settingsPresenter = new SettingsPresenter();
  /** Compactions our controller completed (telemetry for /cache-stats). */
  let compactions = 0;

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
    // cannot abort live work here. We compact only when the provider
    // cache is already lost: a cold last turn (TTL expiry after a gap),
    // or a churning/rotating prefix head — never mid-warm-cache. Pi's
    // own summarizer compaction then runs unchanged.
    try {
      if (!opts.autoCompact) return;
      const usage = ctx.getContextUsage?.();
      // Feed the live cache-health signals into the trigger: session-local
      // last-usage/gap from the ledger, plus prefix-head churn (normalizer)
      // and session-affinity rotation (affinity) — a churned or rotating
      // prefix is already invalidating the provider cache, so compaction
      // there is not additive (inert ledger defaults would swallow them).
      const verdict = autocompact.decide(usage?.percent, {
        lastUsage: () => ledger.lastUsage(),
        msSinceLastTurn: () => ledger.msSinceLastTurn(),
        headChurn: () => normalizer.churn(),
        affinityRotated: () => affinity.rotated(),
      });
      if (verdict.shouldCompact) {
        ctx.compact?.({
          onComplete: () => {
            autocompact.markCompacted();
            compactions++;
          },
          onError: () =>
            pi.appendEntry("pi-cache-advisory", { message: "auto-compact failed" }),
        });
      }
    } catch {
      /* automatic control must never break a turn */
    }
  });

  pi.on("session_before_compact", async (event) => {
    // Warm-cache advisory (observational only). Returns nothing, so the
    // built-in compaction proposal is never altered.
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

  pi.on("session_compact", async (event) => {
    try {
      if (event?.compactionEntry) {
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
      const text = `${line}, ${affinity.status()}, compactions ${compactions}`;
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