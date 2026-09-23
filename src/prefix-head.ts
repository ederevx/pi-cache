/**
 * pi-cache — cache-relevant prefix head.
 *
 * One responsibility: the fingerprint (model, first two system/developer
 * contents, tools array) that the churn counter and the shared OpenAI
 * cache key must hash identically, so they cannot drift apart.
 */

import { createHash } from "node:crypto";

export class PrefixHead {
  /** Stable SHA-256 digest of the head (the model, the first two
   *  system/developer contents, the tools array — a missing one serializes
   *  as null so the field carries signal), truncated to `chars` hex. */
  static hash(payload: Record<string, unknown>, chars: number): string {
    const messages = (payload.messages as Array<{ role?: unknown; content?: unknown }>) ?? [];
    return createHash("sha256")
      .update(
        JSON.stringify({
          model: payload.model,
          sys: messages
            .filter((m) => m.role === "system" || m.role === "developer")
            .slice(0, 2)
            .map((m) => m.content),
          tools: payload.tools ?? null,
        }),
      )
      .digest("hex")
      .slice(0, chars);
  }
}