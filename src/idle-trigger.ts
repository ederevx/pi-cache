/**
 * pi-cache — idle TTL trigger.
 *
 * One responsibility: own the session-scoped timer that fires once when the
 * provider cache TTL elapses while pi is idle, then hands off to the
 * compaction trigger. It only schedules and gates on idleness; the decision
 * and dedup live in `CompactionTrigger`. The timer is unref'd so it never
 * keeps a print-mode process alive, and index disarms it on session
 * boundaries.
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
    const delay = Math.max(this.opts.minDelayMs ?? 1000, remaining);
    const set = this.opts.setTimeoutFn ?? setTimeout;
    const handle = set(() => {
      this.timer = undefined;
      this.fire(ctx);
    }, delay);
    (handle as { unref?: () => void }).unref?.();
    this.timer = handle;
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

  /** Fire the idle compaction if the session is still idle. */
  private fire(ctx: Ctx): void {
    try {
      if (!this.opts.isIdle(ctx)) return;
      void this.opts.compact(ctx);
    } catch {
      /* automatic control must never break the process */
    }
  }
}