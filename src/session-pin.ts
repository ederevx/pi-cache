/**
 * pi-cache — stable provider session-id pinning (cross-spawn cache reuse).
 *
 * One responsibility: when a request carries no provider session-affinity
 * header (pi `--no-session` worker processes), propose a stable
 * `x-session-id` derived from the request's cache-relevant prefix head
 * (model + leading system/developer messages + tools), then inject it on
 * the provider-request headers. Sibling subagent processes with identical
 * tool + system prefixes therefore land in the SAME provider cache bucket,
 * so the second and later spawns hit the provider's cached prefix instead
 * of going cold. When pi already emits a session header (normal interactive
 * session) nothing is injected or overwritten. Standalone: no dependency on
 * any other extension.
 */

import { createHash } from "node:crypto";

export class SessionPinner {
  /** The proposed id for the in-flight request, consumed by apply(). */
  private pending: string | undefined;

  constructor(private enabledOn: boolean = true) {}

  /** The live session-pin switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.enabledOn;
  }

  /** Turn stateless session-id pinning on or off in place. */
  setEnabled(enabled: boolean): void {
    this.enabledOn = enabled;
  }

  /**
   * Called from before_provider_request with the full payload. Computes a
   * stable id from the serialized prefix head; clears it when the request
   * shape cannot be read (then apply() injects nothing).
   */
  propose(payload: unknown): void {
    this.pending = undefined;
    if (!this.enabledOn) return;
    if (!payload || typeof payload !== "object") return;
    const body = payload as Record<string, unknown>;
    const messages = (body.messages as Array<{ role: string; content: unknown }>) ?? [];
    const hash = createHash("sha256")
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
    this.pending = `pi-cache-${hash}`;
  }

  /**
   * Called from before_provider_headers with the headers object. Injects the
   * proposed id only when NO session-affinity header is already present;
   * never overwrites pi's own session routing.
   */
  apply(headers: Record<string, string>): void {
    const proposed = this.pending;
    this.pending = undefined;
    if (!this.enabledOn || !proposed || !headers || typeof headers !== "object") return;
    const existing = Object.keys(headers).some((key) => /session/i.test(key));
    if (existing) return;
    headers["x-session-id"] = proposed;
  }
}