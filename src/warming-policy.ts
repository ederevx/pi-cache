/**
 * pi-cache — cache-warming decision policy.
 *
 * One responsibility: override pi's cache-warming economics when the user
 * asks for it. pi decides warm/stop from an expected-savings model with a
 * $0.05 floor and provider TTLs declared by the model; providers whose
 * real TTL is shorter than the declared tier (or users who simply always
 * want the warm refresh) are underserved by that default. When enabled the
 * policy answers every decision with "warm"; when disabled it stays
 * observational and pi's decision stands. The observer keeps reconciling
 * confirmed refreshes either way, so the idle trigger never compacts a
 * cache a forced warm kept alive.
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
  constructor(private enabledOn: boolean = false) {}

  /** The live force-warm switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.enabledOn;
  }

  /** Turn forced warming on or off in place. */
  setEnabled(enabled: boolean): void {
    this.enabledOn = enabled;
  }

  /** The action this policy returns to pi, or undefined to defer. */
  decide(_event: WarmingDecisionView | undefined): WarmingAction | undefined {
    return this.enabledOn ? "warm" : undefined;
  }
}