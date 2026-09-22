/**
 * pi-cache — mid-history Anthropic breakpoint anchor.
 *
 * One responsibility: spend Anthropic's fourth cache_control breakpoint
 * slot on a stable message-level anchor. pi 0.87 pins three markers
 * (first system block, last tool, last message block); the anchor pins
 * one more on the stable older part of the conversation at a quantum
 * position measured from the START, so it holds across append-only turns
 * and gives a second walk-back lookup window when tail churn (a
 * mid-history edit, branch replay, or a >20-block jump since the last
 * write) would otherwise lose the conversation past the system marker.
 * The anchor never removes or moves pi's own markers and skips whenever
 * the marker budget is spent or explicit mid-history breakpoints exist.
 */

import { Markers, type MessageLike } from "./markers.ts";

export interface BreakpointAnchorOptions {
  /** Blocks between quantum anchor positions (measured from the start). */
  quantum: number;
  /** Blocks the anchor stays behind the trailing marker (Anthropic's
   *  walk-back window); keeps the two windows disjoint. */
  trailingMargin: number;
  /** Minimum block depth an anchor must sit at (Anthropic's per-model
   *  cache floors make shallow anchors useless). */
  minDepth: number;
}

/** Anthropic's hard breakpoint budget (system, tools, messages combined). */
const MAX_MARKERS = 4;

export class BreakpointAnchor {
  /** How many anchors this instance has placed (telemetry). */
  private placed = 0;

  constructor(
    private enabledOn: boolean = true,
    readonly options: BreakpointAnchorOptions = {
      quantum: 24,
      trailingMargin: 20,
      minDepth: 24,
    },
  ) {}

  /** The live anchor switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.enabledOn;
  }

  /** Turn the anchor on or off in place. */
  setEnabled(enabled: boolean): void {
    this.enabledOn = enabled;
  }

  /** How many anchors have been placed so far. */
  count(): number {
    return this.placed;
  }

  /**
   * Add the anchor marker to a payload in place. A no-op for non-Anthropic
   * shapes (no existing message marker proves the format), short histories,
   * or payloads already at the marker budget.
   */
  apply(payload: unknown): void {
    if (!this.enabledOn) return;
    if (!payload || typeof payload !== "object") return;
    const body = payload as Record<string, unknown>;
    const messages = body.messages as MessageLike[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) return;
    const index = Markers.collect(payload);
    const messageMarkers = index.messages;
    // At least one existing message-level marker proves the provider path
    // emits message blocks with cache_control (pi always pins one).
    const trailing = messageMarkers[messageMarkers.length - 1];
    if (!trailing) return;
    const total = index.system.length + index.tools.length + messageMarkers.length;
    if (total >= MAX_MARKERS) return;
    // Respect explicit mid-history breakpoints: never add a second window
    // inside someone else's breakpoint plan.
    const anchorPosition = this.anchorPosition(trailing.position, messageMarkers);
    if (anchorPosition === undefined) return;
    const holder = this.holderAt(messages, anchorPosition);
    if (!holder || Markers.isCacheControl(holder.cache_control)) return;
    holder.cache_control = trailing.holder.cache_control;
    this.placed++;
  }

  /** The quantum-aligned anchor position, or undefined when none applies. */
  private anchorPosition(
    trailingPosition: number,
    messageMarkers: Array<{ position: number }>,
  ): number | undefined {
    const ceiling = trailingPosition - this.options.trailingMargin;
    if (ceiling < this.options.minDepth) return undefined;
    const position = Math.floor(ceiling / this.options.quantum) * this.options.quantum;
    if (position < this.options.minDepth) return undefined;
    // Any earlier message marker means explicit breakpoints; leave them be.
    if (messageMarkers.some((m) => m.position < trailingPosition && m.position <= position)) {
      return undefined;
    }
    return position;
  }

  /** The last content block of the message covering 1-based `position`. */
  private holderAt(
    messages: MessageLike[],
    position: number,
  ): Record<string, unknown> | undefined {
    let seen = 0;
    for (const message of messages) {
      const blocks = Markers.contentBlocks(message);
      seen += blocks.length;
      if (seen >= position) {
        const last = blocks[blocks.length - 1];
        return typeof last === "object" && last !== null ? last : undefined;
      }
    }
    return undefined;
  }
}
