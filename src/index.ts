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
 *                            soft-compaction proposal (last-truthy wins);
 *                            our proposal also stashes a verbatim capture
 *                            of the span this pass will drop
 *   session_compact        — compaction telemetry + store write of the
 *                            captured artifact (atomic, ring/GC'ed)
 *   session_compact_failed — drop any pending capture (no write)
 *   session_shutdown       — drop any pending capture (no write)
 *   session_start          — idle fail-open GC pass over the compact store
 *
 * Command:
 *   /cache-stats           — session cache-ratio, churn, affinity, compactions
 *
 * Config: PI_CACHE_* environment variables only (no config JSON — house
 * rule); durable telemetry to the `.pi-cache/` dot-dir under the agent
 * dir (see constants.ts); soft-compaction captures reach a temporary
 * store at ~/tmp/pi-cache/compacts (see compactstore.ts).
 */

import { loadOptions } from "./constants.ts";
import { CacheLedger } from "./ledger.ts";
import { FileRecordSink } from "./sink.ts";
import { PrefixNormalizer } from "./normalizer.ts";
import { CompactionAdvisor } from "./compaction.ts";
import { AffinityObserver } from "./affinity.ts";
import { AutocompactController } from "./autocompact.ts";
import { SoftCompactionController } from "./softcompact.ts";
import { CompactStorePaths, CompactCapture, CompactGC, type BranchEntryView } from "./compactstore.ts";
import { SettingsPresenter } from "./settings.ts";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Normalize unknown handler payload shapes with a safe local view. */
type ModelView = { model?: { id?: string } | undefined } | undefined;

/** In-memory capture stashed at proposal time; written on session_compact. */
type CapturedArtifact = {
  sessionId: string;
  seq: number;
  reason: string;
  tokensBefore: number;
  firstKeptEntryId: string;
  prevFirstKeptEntryId: string | undefined;
  entryCount: number;
  artifactPath: string;
  text: string;
};

/** Resolve the previous compaction cut: parsed JSON summary if it carries
 *  firstKeptEntryId, else the most recent compaction entry in the branch
 *  (our own stubs are plain text, so the entry's cut is the authority). */
function priorSummaryCut(
  branchEntries: readonly BranchEntryView[],
  previousSummary: string | undefined,
): { firstKeptEntryId?: string } | undefined {
  if (previousSummary) {
    try {
      const parsed = JSON.parse(previousSummary) as { firstKeptEntryId?: unknown };
      if (typeof parsed.firstKeptEntryId === "string") {
        return { firstKeptEntryId: parsed.firstKeptEntryId };
      }
    } catch {
      /* not JSON: fall through to the branch scan */
    }
  }
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry.type === "compaction" && typeof entry.firstKeptEntryId === "string") {
      return { firstKeptEntryId: entry.firstKeptEntryId };
    }
  }
  return undefined;
}

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

  // Compacted-entry capture store (see compactstore.ts). Constructed even
  // when capture is disabled (harmless no-op), and pruned fail-open once
  // at load so no stale artifact survives a restart.
  const storePaths = new CompactStorePaths(opts.compactDir);
  const compactCapture = new CompactCapture();
  const compactGC = new CompactGC(storePaths, {
    ring: opts.compactRing,
    maxArtifacts: opts.compactMaxArtifacts,
    ttlMs: opts.compactTtlDays * 24 * 60 * 60 * 1000,
  });
  if (opts.compactCapture) {
    try {
      compactGC.prune();
    } catch {
      /* fail-open: the store must never block extension load */
    }
  }
  let captured: CapturedArtifact | undefined;

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

  pi.on("session_before_compact", async (event, ctx) => {
    // Listener 2 of 2: soft-compaction proposal. Override ONLY compactions
    // we triggered (ours via ctx.compact(), or pi's own threshold/overflow
    // compaction when it lands while the trigger is armed); built-in
    // compactions we did not arm pass through untouched. Peek here;
    // propose() is the single consumer of the flag. When OUR proposal
    // fired, also stash a verbatim capture of the span this pass drops —
    // written to the compact store on session_compact (no I/O here).
    try {
      if (!softcompact.isTriggered()) return;
      const proposal = await softcompact.propose({
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      });
      if (!proposal) return; // fail-open: pi's default summarization runs
      if (opts.compactCapture) {
        try {
          const entries = event.branchEntries as unknown as readonly BranchEntryView[];
          const sessionId = ctx.sessionManager.getSessionId();
          const seq = storePaths.nextSeq(sessionId);
          const delta = compactCapture.deriveDelta(
            entries,
            priorSummaryCut(entries, event.preparation.previousSummary),
            { firstKeptEntryId: event.preparation.firstKeptEntryId },
          );
          const text = compactCapture.serialize({
            sessionId,
            sessionFile: ctx.sessionManager.getSessionFile?.(),
            seq,
            reason: event.reason,
            tokensBefore: event.preparation.tokensBefore,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            prevFirstKeptEntryId: delta.prevFirstKeptEntryId,
            prevStubId: delta.prevStubId,
            entries: delta.entries,
            maxBytes: opts.compactMaxMb * 1024 * 1024,
          });
          captured = {
            sessionId,
            seq,
            reason: event.reason,
            tokensBefore: event.preparation.tokensBefore,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            prevFirstKeptEntryId: delta.prevFirstKeptEntryId,
            entryCount: delta.entries.length,
            artifactPath: storePaths.artifactPath(
              sessionId,
              seq,
              event.preparation.firstKeptEntryId,
            ),
            text,
          };
        } catch {
          /* capture is best-effort: the compaction itself proceeds */
        }
      }
      return { compaction: proposal };
    } catch {
      /* never break compaction */
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    try {
      softcompact.recordCompaction();
      // Write the stashed capture (proposal-time span) atomically, refresh
      // both LATEST pointers, then GC. Never lets the store break telemetry.
      let artifact: string | undefined;
      let latest: string | undefined;
      if (
        opts.compactCapture &&
        captured !== undefined &&
        captured.sessionId === ctx.sessionManager.getSessionId()
      ) {
        try {
          storePaths.writeArtifact(captured.artifactPath, captured.text);
          storePaths.writeLatest(
            storePaths.latestFile(captured.sessionId),
            captured.sessionId,
            basename(captured.artifactPath),
          );
          storePaths.writeLatest(
            storePaths.globalLatestFile(),
            captured.sessionId,
            storePaths.artifactRef(captured.sessionId, captured.artifactPath),
          );
          artifact = captured.artifactPath;
          latest = storePaths.globalLatestFile();
          try {
            compactGC.prune();
          } catch {
            /* fail-open: GC must never break the turn */
          }
        } catch {
          /* store write must never break the turn */
        }
        captured = undefined;
      }
      if (event.compactionEntry) {
        const data: Record<string, unknown> = {
          keptEntryId: event.compactionEntry.firstKeptEntryId,
          tokensBefore: event.compactionEntry.tokensBefore,
          fromExtension: event.compactionEntry.fromHook,
        };
        if (artifact !== undefined) data.artifact = artifact;
        if (latest !== undefined) data.latest = latest;
        pi.appendEntry("pi-cache-compaction", data);
      }
    } catch {
      /* telemetry only */
    }
  });

  pi.on("session_compact_failed", async () => {
    // Nothing was compacted: drop the pending capture without writing.
    captured = undefined;
  });

  pi.on("session_shutdown", async () => {
    // No compaction can complete across a teardown: drop the pending stash.
    captured = undefined;
  });

  pi.on("session_start", async () => {
    // Idle GC pass: stale artifacts from a crashed run are pruned on the
    // next start. Fail-open — GC must never break session start.
    try {
      if (opts.compactCapture) compactGC.prune();
    } catch {
      /* fail-open */
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