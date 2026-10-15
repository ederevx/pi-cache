/**
 * pi-cache — agent-requested compaction tool.
 *
 * One responsibility: register and own the `cache_compact` model-callable
 * tool. The agent may deliberately request a compaction (typically when the
 * user asks for a complete context switch); the request is deferred to the
 * next settled boundary so the tool result is delivered and the live run is
 * never aborted. The tool reports the draw-free cache state it based the
 * request on, and accepts at most one request per run: repeated calls
 * coalesce instead of stacking.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CacheStateContext, CacheStateReader, CacheStateSnapshot } from "./cache-state.ts";

/** One queued explicit compaction request awaiting a settled boundary. */
export interface PendingCompaction {
  id: string;
  reason: string;
}

export class CacheCompactTool {
  private pending: PendingCompaction | undefined;
  private seq = 0;

  constructor(private readonly state: CacheStateReader) {}

  /** Register the tool. The pre_cache gate lists it as an owned tool. */
  register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "cache_compact",
      label: "cache_compact",
      description:
        "Request a context compaction and return the live cache state. Call " +
        "pre_cache first. Use it when the user asks for a complete context " +
        "switch or the context is carrying finished work; it runs at the " +
        "next settled boundary, so acceptance is not completion and the run " +
        "is not aborted. Do not call it repeatedly in one run.",
      parameters: Type.Object({
        reason: Type.String({
          minLength: 1,
          maxLength: 1000,
          description: "Why the compaction is wanted (telemetry only).",
        }),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
      execute: async (
        _toolCallId: string,
        params: { reason?: string },
        _signal: unknown,
        _onUpdate: unknown,
        ctx: CacheStateContext,
      ) => {
        const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
        if (reason === "") {
          return {
            content: [{ type: "text", text: "cache_compact requires a non-empty reason." }],
            details: { requested: false, error: "reason required" },
            isError: true,
          };
        }
        const duplicate = this.pending !== undefined;
        if (!this.pending) this.pending = { id: `compact-${++this.seq}`, reason };
        const snapshot = this.state.read(ctx);
        return {
          content: [{ type: "text", text: this.receipt(duplicate, snapshot) }],
          details: { requested: true, duplicate, state: snapshot },
        };
      },
    });
  }

  /** The queued request for a settled-boundary attempt, if any. Kept until
   *  `finish` so parallel duplicate calls in the same run coalesce. */
  takeForSettlement(): PendingCompaction | undefined {
    return this.pending;
  }

  /** Resolve the queued request after its boundary attempt. */
  finish(_completed: boolean): void {
    this.pending = undefined;
  }

  /** Drop session-owned request state (session replacement). */
  reset(): void {
    this.pending = undefined;
  }

  /** Model-facing receipt: what was requested and the state behind it. */
  private receipt(duplicate: boolean, s: CacheStateSnapshot): string {
    const lines = [
      duplicate
        ? "cache_compact: already queued in this run; the existing request stands."
        : "cache_compact: request queued for the next settled boundary.",
      `global (all time): ${CacheCompactTool.scope(s.global)}`,
      `session: ${CacheCompactTool.scope(s.session)}`,
      s.context
        ? `context: ${s.context.tokens.toLocaleString()}/${s.context.contextWindow.toLocaleString()} tokens (${s.context.percent.toFixed(0)}%)`
        : "context: unavailable",
      s.pressure
        ? `pressure ${s.pressure.pressure.toFixed(2)} (p ${(s.pressure.probability * 100).toFixed(0)}%)`
        : "pressure: unavailable",
      `auto-compaction ${s.autoEnabled ? "on" : "off"}; fast compaction ${s.fastEnabled ? "on" : "off"}; telemetry ${s.telemetryEnabled ? "on" : "off"}`,
      "Deferred to a settled boundary so this run is not aborted; acceptance is not completion.",
    ];
    return lines.join("\n");
  }

  /** One "N req, read X / in Y (Z%), writes W" scope fragment. */
  private static scope(totals: { n: number; input: number; cacheRead: number; cacheWrite: number }): string {
    if (totals.n === 0) return "no usage recorded yet";
    const denominator = totals.input + totals.cacheRead;
    const ratio = denominator > 0 ? totals.cacheRead / denominator : 0;
    return (
      `${totals.n} req, read ${totals.cacheRead.toLocaleString()} / ` +
      `in ${totals.input.toLocaleString()} (${(ratio * 100).toFixed(1)}%), ` +
      `writes ${totals.cacheWrite.toLocaleString()}`
    );
  }
}
