/**
 * pi-cache — awaitable compaction request.
 *
 * One responsibility: adapt pi's fire-and-forget `ctx.compact()` to a
 * Promise so a before-turn trigger can defer the prompt until compaction
 * finishes, and report a failed or refused compaction through one
 * fail-open advisory callback. Never throws.
 */

/** The `ctx.compact` surface this class depends on (structurally typed). */
export interface CompactableContext {
  compact?: (options?: {
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }) => void;
}

export class CompactionRequest {
  constructor(private readonly onFailure?: () => void) {}

  /** Run compaction; resolves true on completion, false on failure/absence. */
  request(ctx: CompactableContext): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        if (typeof ctx.compact !== "function") {
          finish(false);
          return;
        }
        ctx.compact({
          onComplete: () => finish(true),
          onError: () => {
            this.reportFailure();
            finish(false);
          },
        });
      } catch {
        this.reportFailure();
        finish(false);
      }
    });
  }

  /** Invoke the failure advisory without ever letting it throw. */
  private reportFailure(): void {
    try {
      this.onFailure?.();
    } catch {
      /* a failed advisory must never break the caller */
    }
  }
}