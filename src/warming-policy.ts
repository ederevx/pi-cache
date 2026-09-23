/**
 * pi-cache — cache-warming decision policy.
 *
 * One responsibility: override pi's cache-warming decision where pi-cache
 * knows better, and defer everywhere else. pi decides warm/stop from an
 * expected-savings model (`continuationProbability * missCost - warmCost`)
 * with a $0.05 floor, computed from a request-scoped retention tier that
 * pi-cache's per-request rewrite can change after the fact — so when the
 * override lengthened the effective tier, pi's scheduler wakes too early.
 * The policy therefore answers "warm" only when pi's own numbers still
 * clear its floor (keep the refresh, cheap insurance) or when pi's numbers
 * are unavailable (sub-minimum warm costs); it defers otherwise so pi's
 * economics stand. When the policy is disabled it is fully observational.
 * The observer keeps reconciling confirmed refreshes either way, so the
 * idle trigger never compacts a cache a kept-alive warm refreshed.
 */

import type { WarmingAction } from "./warming-observer.ts";

/** The decision event pi hands to the hook (narrowed view). */
export interface WarmingDecisionView {
  action?: WarmingAction;
  warmCost?: unknown;
  missCost?: unknown;
  continuationProbability?: unknown;
}

export class WarmingPolicy {
  /** pi's own expected-savings floor ($): matches CacheWarmer so an
   *  override fires only when pi's economics also justified the warm. */
  private static readonly SAVINGS_FLOOR_DOLLARS = 0.05;

  constructor(
    private enabledOn: boolean = false,
    private readonly evidence: { hasPromptEvidence?: () => boolean } = {},
  ) {}

  /** The live force-warm switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.enabledOn;
  }

  /** Turn forced warming on or off in place. */
  setEnabled(enabled: boolean): void {
    this.enabledOn = enabled;
  }

  /** The action this policy returns to pi, or undefined to defer. */
  decide(event: WarmingDecisionView | undefined): WarmingAction | undefined {
    if (!this.enabledOn) return undefined;
    const savings = this.expectedSavings(event);
    // pi's economics are absent or incomputable (sub-minimum warm costs
    // hide the fields): keep the refresh — the cheap, conservative warm —
    // but only when a real prompt exists to keep warm. An empty prefix
    // (no turn recorded yet) has nothing to refresh, so defer.
    if (savings === undefined) {
      return this.evidence.hasPromptEvidence && !this.evidence.hasPromptEvidence()
        ? undefined
        : "warm";
    }
    return savings >= WarmingPolicy.SAVINGS_FLOOR_DOLLARS ? "warm" : undefined;
  }

  /** pi's expected savings from the decision event, or undefined when its
   *  economics are unavailable (fields absent or not numeric). */
  private expectedSavings(event: WarmingDecisionView | undefined): number | undefined {
    const warm = this.asNumber(event?.warmCost);
    const miss = this.asNumber(event?.missCost);
    const continuation = this.asNumber(event?.continuationProbability);
    if (warm === undefined || miss === undefined || continuation === undefined) {
      return undefined;
    }
    return continuation * miss - warm;
  }

  /** A decision field as a finite number, or undefined. */
  private asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
}