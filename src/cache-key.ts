/**
 * pi-cache — shared prompt_cache_key derivation.
 *
 * One responsibility: when opted in, replace pi's per-session
 * `prompt_cache_key` with a key derived from the request's cache-relevant
 * prefix head (model + leading system/developer content + tools), so
 * sibling sessions whose prefixes start identically route into the same
 * cache bucket and share a warm prefix instead of each going cold.
 * The key is stable while the head is stable and changes with the head, so
 * a bucket never outlives the prefix that keyed it.
 *
 * pi-ai also sets the key on long-tier compatible completions endpoints
 * and on every openai-responses target, whose head lives in `input` /
 * `instructions` rather than `messages`; only chat-completions bodies are
 * rewritten, so those keep their per-session key.
 */

import { PrefixHead } from "./prefix-head.ts";

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
   * Payloads without one, or without a `messages` array, are untouched.
   */
  apply(payload: unknown): void {
    if (!this.enabledOn) return;
    if (!payload || typeof payload !== "object") return;
    const body = payload as Record<string, unknown>;
    if (typeof body.prompt_cache_key !== "string") return;
    if (!Array.isArray(body.messages)) return;
    body.prompt_cache_key = `pi-cache-${this.headHash(body)}`;
  }

  /** Stable 24-hex digest of the prefix head (mirrors the pinner's head). */
  private headHash(body: Record<string, unknown>): string {
    return PrefixHead.hash(body, 24);
  }
}