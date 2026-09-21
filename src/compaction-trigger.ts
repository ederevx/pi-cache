/**
 * pi-cache — compaction trigger.
 *
 * One responsibility: decide whether the current context should compact,
 * claim the idle window through the gate, run the compaction request, and
 * release the gate. Both the idle timer and the before-turn handler call
 * this same object so the decision, dedup, and cooldown have one owner.
 */

import type { CompactionGate } from "./compaction-gate.ts";
import type { CompactionRequest, CompactableContext } from "./compaction-request.ts";

export interface CompactionTriggerOptions<Ctx extends CompactableContext> {
  /** Pure decision: would a compaction fire for this context right now? */
  shouldCompact(ctx: Ctx): boolean;
  /** Identity of the idle window (session + last recorded row). */
  keyOf(ctx: Ctx): string;
  gate: CompactionGate;
  request: CompactionRequest;
}

export class CompactionTrigger<Ctx extends CompactableContext> {
  constructor(private readonly opts: CompactionTriggerOptions<Ctx>) {}

  /** Whether a compaction would fire (no side effects). */
  shouldCompact(ctx: Ctx): boolean {
    try {
      return this.opts.shouldCompact(ctx);
    } catch {
      return false;
    }
  }

  /** Claim, compact, and settle; false when declined, gated, or failed. */
  async tryCompact(ctx: Ctx): Promise<boolean> {
    if (!this.shouldCompact(ctx)) return false;
    const key = this.opts.keyOf(ctx);
    if (!this.opts.gate.tryBegin(key)) return false;
    let completed = false;
    try {
      completed = await this.opts.request.request(ctx);
    } catch {
      completed = false;
    }
    this.opts.gate.settle(key);
    return completed;
  }
}