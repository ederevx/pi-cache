/**
 * pi-cache — idle TTL trigger.
 *
 * One responsibility: own the session-scoped timer that fires once when the
 * provider cache TTL elapses while pi is idle, then hands off to the
 * compaction trigger. It only schedules and gates on idleness; the decision
 * and dedup live in `CompactionTrigger`. The timer is unref'd so it never
 * keeps a print-mode process alive, and index disarms it on session
 * boundaries.
 *
 * Warm-vs-compact race: a warm refresh's `cache_warm` usage entry lands
 * only after its provider round-trip, so between the decision intent and
 * the confirmation the idle timer can read a stale cache touch and fire a
 * compaction into a cache pi is about to refresh. `arm` therefore guards
 * on the injected `warmingMarginMs`: while a warm decision is younger than
 * its margin plus a round-trip grace, the fire is deferred until the
 * refresh has had time to land and reset the idle clock. The guard is
 * observational when no margin is injected, preserving the pre-guard
 * behavior for tests and callers that do not wire it.
 */

type TimerHandle = ReturnType<typeof setTimeout>;

export interface IdleTriggerOptions<Ctx> {
  /** Whether the trigger may arm; read live so toggling auto-compaction
   *  off in /cache-settings stops scheduling immediately. */
  isEnabled(): boolean;
  /** pi is idle (not streaming and not already compacting). */
  isIdle(ctx: Ctx): boolean;
  /** Milliseconds since the cache was last touched (turn or warm). */
  idleMs(ctx: Ctx): number;
  /** Provider cache lifetime in milliseconds. */
  ttlMs(ctx: Ctx): number;
  /** Fired at TTL expiry; the trigger awaits nothing. */
  compact(ctx: Ctx): Promise<boolean>;
  /** Milliseconds since pi's warm decision intent, when observed; a
   *  decision younger than its refresh margin defers the fire. */
  msSinceWarmDecision?(): number | undefined;
  /** The warm refresh margin (ms) a young decision defers the fire by. */
  warmMarginMs?(): number | undefined;
  /** Round-trip allowance (ms) past the margin: pi's refresh may still
   *  be in flight when the margin elapses (late timers are anticipated
   *  upstream), and the `cache_warm` confirmation only lands after the
   *  response. The fire defers until margin+grace, so it cannot compact
   *  into a cache being refreshed. Default 30s. */
  warmGraceMs?: number;
  /** Injectable timer seams for deterministic tests. */
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
  /** Floor so a just-settled turn does not schedule an immediate fire. */
  minDelayMs?: number;
}

export class IdleTrigger<Ctx> {
  private timer: TimerHandle | undefined;

  constructor(private readonly opts: IdleTriggerOptions<Ctx>) {}

  /** (Re)arm the timer to fire when the current cache TTL elapses. */
  arm(ctx: Ctx): void {
    if (!this.opts.isEnabled()) return;
    this.disarm();
    const remaining = this.opts.ttlMs(ctx) - this.opts.idleMs(ctx);
    if (!Number.isFinite(remaining)) return;
    this.schedule(ctx, Math.max(this.opts.minDelayMs ?? 1000, remaining, this.warmDeferralMs()));
  }

  /** Cancel any pending fire (run started, session ended, user returned). */
  disarm(): void {
    if (this.timer === undefined) return;
    const clear = this.opts.clearTimeoutFn ?? clearTimeout;
    clear(this.timer);
    this.timer = undefined;
  }

  /** Whether a fire is scheduled (test/telemetry helper). */
  get armed(): boolean {
    return this.timer !== undefined;
  }

  /** Schedule one fire after `delayMs`; the handle is unref'd so it never
   *  keeps a print-mode process alive. */
  private schedule(ctx: Ctx, delayMs: number): void {
    const set = this.opts.setTimeoutFn ?? setTimeout;
    const handle = set(() => {
      this.timer = undefined;
      this.fire(ctx);
    }, delayMs);
    (handle as { unref?: () => void }).unref?.();
    this.timer = handle;
  }

  /** Fire the idle compaction if the session is still idle. A warm
   *  decision that arrived after arming re-defers here: the fire waits
   *  out the refresh margin plus the round-trip grace so the refresh
   *  can land and reset the idle clock first. */
  private fire(ctx: Ctx): void {
    try {
      if (!this.opts.isIdle(ctx)) return;
      const deferral = this.warmDeferralMs();
      if (deferral > 0) {
        this.schedule(ctx, deferral);
        return;
      }
      void this.opts.compact(ctx);
    } catch {
      /* automatic control must never break the process */
    }
  }

  /** How long a young warm decision defers the fire: the unelapsed part
   *  of its refresh margin plus the round-trip grace, so the refresh
   *  lands and resets the idle clock before the fire. An unobserved
   *  guard (no margins) defers nothing. */
  private warmDeferralMs(): number {
    const since = this.opts.msSinceWarmDecision?.();
    const margin = this.opts.warmMarginMs?.();
    if (typeof since !== "number" || typeof margin !== "number") return 0;
    const horizon = margin + (this.opts.warmGraceMs ?? 30_000);
    return since >= horizon ? 0 : horizon - since;
  }
}