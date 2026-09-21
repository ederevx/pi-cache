/**
 * pi-cache — before-turn trigger.
 *
 * One responsibility: at the `input` hook, when the cache has gone cold,
 * defer the user's prompt by awaiting compaction before returning. pi awaits
 * input handlers before it builds the turn, so the prompt is effectively
 * held until compaction finishes and then continues with the compacted
 * context — no re-send, so a deferred prompt can never be lost in print
 * mode.
 */

export interface BeforeTurnTriggerOptions<Ctx, Event> {
  /** Whether the trigger may defer; read live so toggling auto-compaction
   *  off in /cache-settings stops deferral immediately. */
  isEnabled(): boolean;
  /** Whether this input starts an idle turn the trigger may defer. */
  eligible(event: Event): boolean;
  /** Pure decision from the shared compaction trigger. */
  shouldCompact(ctx: Ctx): boolean;
  /** Defer the prompt until compaction completes. */
  compact(ctx: Ctx): Promise<boolean>;
  /** A new turn means any idle timer is stale. */
  disarmIdle(): void;
}

export class BeforeTurnTrigger<Ctx, Event> {
  constructor(private readonly opts: BeforeTurnTriggerOptions<Ctx, Event>) {}

  /** Handle one input; returns after the prompt is safe to continue. */
  async handle(event: Event, ctx: Ctx): Promise<void> {
    // Any input means the user is active and the idle timer is stale, even
    // when this trigger is disabled or the input is not deferrable.
    this.opts.disarmIdle();
    if (!this.opts.isEnabled()) return;
    if (!this.opts.eligible(event)) return;
    if (!this.opts.shouldCompact(ctx)) return;
    try {
      await this.opts.compact(ctx);
    } catch {
      /* fail-open: the prompt continues even if compaction failed */
    }
  }
}