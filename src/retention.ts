/**
 * pi-cache — per-request cache retention override.
 *
 * One responsibility: upgrade or leave the wire retention tier per request
 * instead of only through pi's process-wide `PI_CACHE_RETENTION` env var.
 * When enabled, every existing cache_control marker is upgraded to the 1h
 * tier (Anthropic format; markers prove the format applies) and OpenAI
 * payloads already carrying a prompt_cache_key get the 24h retention tier.
 * The rewrite only touches markers pi itself emitted, so a provider path
 * that never accepted cache_control is never fed one. The effective tier
 * is reported so TTL-based signals follow the wire, not a static env flag.
 *
 * Precedence (audit-established): this per-request rewrite wins over pi's
 * env resolution because it runs after pi-ai built the request; the env
 * var remains the default tier when the override is off.
 */

import { Markers } from "./markers.ts";

export class RetentionRewriter {
  /** The effective tier of the last payload this instance saw. */
  private lastEffectiveLong: boolean | undefined;

  constructor(private enabledOn: boolean = false) {}

  /** The live retention-override switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.enabledOn;
  }

  /** Turn the per-request override on or off in place. */
  setEnabled(enabled: boolean): void {
    this.enabledOn = enabled;
  }

  /**
   * Whether the last applied payload is on the long tier (true), short
   * tier (false), or unknown — e.g. the override never ran (undefined).
   */
  effectiveLong(): boolean | undefined {
    return this.lastEffectiveLong;
  }

  /**
   * Upgrade markers to the long tier in place: Anthropic-style markers get
   * ttl "1h" (never mixed tiers — every marker is upgraded together), and
   * an OpenAI payload carrying prompt_cache_key gets prompt_cache_retention
   * "24h". Records the effective tier for the session signals.
   */
  apply(payload: unknown): void {
    this.lastEffectiveLong = undefined;
    if (!this.enabledOn) return;
    if (!payload || typeof payload !== "object") return;
    const body = payload as Record<string, unknown>;
    const index = Markers.collect(payload);
    let sawMarkers = false;
    for (const ref of [...index.system, ...index.tools, ...index.messages]) {
      const raw = ref.holder.cache_control as Record<string, unknown>;
      if (!Markers.isCacheControl(raw)) continue;
      sawMarkers = true;
      if (raw.ttl !== "1h") ref.holder.cache_control = { ...raw, ttl: "1h" };
    }
    let openaiLong = false;
    if (typeof body.prompt_cache_key === "string") {
      if (body.prompt_cache_retention !== "24h") body.prompt_cache_retention = "24h";
      openaiLong = true;
    }
    this.lastEffectiveLong = sawMarkers || openaiLong ? true : undefined;
  }
}