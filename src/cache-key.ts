/**
 * pi-cache — shared OpenAI prompt_cache_key derivation.
 *
 * One responsibility: when opted in, replace pi's per-session
 * `prompt_cache_key` with a key derived from the request's cache-relevant
 * prefix head (model + leading system/developer content + tools), so
 * sibling sessions whose prefixes start identically route into the same
 * OpenAI cache bucket and share a warm prefix instead of each going cold.
 * The key is stable while the head is stable and changes with the head, so
 * a bucket never outlives the prefix that keyed it. Only payloads that
 * already carry a prompt_cache_key are touched — that field's presence is
 * pi-ai's own proof the target is api.openai.com (or a long-retention
 * compatible endpoint).
 */

import { createHash } from "node:crypto";

export class CacheKeySharer {
  constructor(private enabledOn: boolean = false) {}

  /** The live shared-key switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.enabledOn;
  }

  /** Turn shared-key derivation on or off in place. */
  setEnabled(enabled: boolean): void {
    this.enabledOn = enabled;
  }

  /**
   * Replace an existing prompt_cache_key with the head-derived shared key.
   * Payloads without one (openrouter, anthropic-direct) are untouched.
   */
  apply(payload: unknown): void {
    if (!this.enabledOn) return;
    if (!payload || typeof payload !== "object") return;
    const body = payload as Record<string, unknown>;
    if (typeof body.prompt_cache_key !== "string") return;
    body.prompt_cache_key = `pi-cache-${this.headHash(body)}`;
  }

  /** Stable 24-hex digest of the prefix head (mirrors the pinner's head). */
  private headHash(body: Record<string, unknown>): string {
    const messages = (body.messages as Array<{ role?: unknown; content?: unknown }>) ?? [];
    return createHash("sha256")
      .update(
        JSON.stringify({
          model: body.model,
          sys: messages
            .filter((m) => m.role === "system" || m.role === "developer")
            .slice(0, 2)
            .map((m) => m.content),
          tools: body.tools ?? null,
        }),
      )
      .digest("hex")
      .slice(0, 24);
  }
}