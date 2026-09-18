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
 *   turn_end               — turn bookkeeping for auto-compaction
 *   agent_settled          — opt-in cache-aware auto-compaction trigger
 *   session_before_compact — observational warm-cache advisory
 *
 * Command:
 *   /cache-stats           — session cache-ratio and write churn
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
  const advisor = new CompactionAdvisor({
    enabled: opts.advisory,
    warmRatioThreshold: opts.warmRatioThreshold,
    advisoryMinTokens: opts.advisoryMinTokens,
  });
  const affinity = new AffinityObserver();
  const autocompact = new AutocompactController({
    enabled: opts.autoCompact,
    coldRatio: opts.coldRatio,
    minContextPercent: opts.minContextPercent,
    cooldownSeconds: opts.cooldownSeconds,
    cooldownTurns: opts.cooldownTurns,
    minGapSeconds: opts.minGapSeconds,
  });

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
    } catch {
      /* bookkeeping only */
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      if (!opts.autoCompact) return;
      // agent_settled is the guaranteed-idle point (no retry/compaction/
      // continuation will run), so compact() cannot abort live work here.
      const usage = ctx.getContextUsage?.();
      const verdict = autocompact.decide(usage?.percent, ledger);
      if (!verdict.shouldCompact) return;
      ctx.compact?.({
        onComplete: () => autocompact.markCompacted(),
        onError: () =>
          pi.appendEntry("pi-cache-advisory", { message: "auto-compact failed" }),
      });
    } catch {
      /* automatic control must never break a turn */
    }
  });

  pi.on("session_before_compact", async (event) => {
    try {
      const tip = advisor.suggest(
        ledger.totals(),
        event.preparation.messagesToSummarize.length,
        event.preparation.tokensBefore,
      );
      if (tip) pi.appendEntry("pi-cache-advisory", { message: tip });
    } catch {
      /* advisory only */
    }
  });

  pi.registerCommand("cache-stats", {
    description: "Show pi-cache usage, cache ratio, and head churn",
    handler: async (_args, ctx) => {
      const base = ledger.summary();
      const churn = normalizer.churn();
      const line = churn > 0 ? `${base}, head churn ${churn}` : base;
      const text = `${line}, ${affinity.status()}`;
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