/**
 * pi-cache — request-prefix normalizer.
 *
 * One responsibility: make the provider-serialized prefix as byte-stable
 * as economics permit, and report churn. Only the tools array is ever
 * reordered or deduplicated; conversation messages are never touched
 * (role/tool-result association must stay intact). All transforms are
 * opt-in; without them the class only tracks head-churn.
 */

import { createHash } from "node:crypto";

export interface PrefixNormalizerOptions {
  sortTools: boolean;
  dedupTools: boolean;
}

export interface ToolLike {
  name?: unknown;
  [key: string]: unknown;
}

export class PrefixNormalizer {
  private lastHeadHash = "";
  private churnCount = 0;

  constructor(private readonly opts: PrefixNormalizerOptions) {}

  /** The live deterministic-sort switch (toggled from /cache-settings). */
  get sortTools(): boolean {
    return this.opts.sortTools;
  }

  /** The live duplicate-schema drop switch (toggled from /cache-settings). */
  get dedupTools(): boolean {
    return this.opts.dedupTools;
  }

  setSortTools(enabled: boolean): void {
    this.opts.sortTools = enabled;
  }

  setDedupTools(enabled: boolean): void {
    this.opts.dedupTools = enabled;
  }

  /**
   * Apply opt-in tools transforms to a provider payload, returning the
   * original object when unchanged (so pi keeps its own reference — the
   * null transform also preserves the payload for later handlers).
   */
  normalize(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const body = payload as Record<string, unknown>;
    if (Array.isArray(body.tools)) {
      const changed = this.transformTools(body);
      this.noteHead(body);
      return changed ? body : payload;
    }
    return payload;
  }

  /** Sort/dedup tools in place; reports whether anything changed. */
  private transformTools(body: Record<string, unknown>): boolean {
    const tools = body.tools as ToolLike[];
    const markerIndex = tools.findIndex((t) => t.cache_control !== undefined);
    const hasMarker = markerIndex !== -1;
    // Anthropic/OpenRouter pin cache_control to the LAST immediate tool;
    // a mid-array marker means explicit breakpoints we must not disturb.
    const markerOnLast = markerIndex === -1 || markerIndex === tools.length - 1;
    if (hasMarker && !markerOnLast) return false;
    const marker = hasMarker ? (tools[markerIndex].cache_control as unknown) : undefined;

    let result = tools;
    let changed = false;

    if (this.opts.dedupTools) {
      const deduped = this.dedup(result);
      if (deduped !== result) {
        result = deduped;
        changed = true;
      }
    }

    if (this.opts.sortTools) {
      const sorted = this.sortByName(result);
      if (sorted !== result) {
        result = sorted;
        changed = true;
      }
    }

    if (changed) {
      // Re-pin a trailing Anthropic cache_control marker to the new last
      // tool (sort/dedup move it otherwise, breaking the breakpoint).
      if (hasMarker && marker !== undefined) result = this.repinMarker(result, marker);
      body.tools = result;
    }
    return changed;
  }

  /** Drop exact-duplicate tool schemas; returns the same array when unchanged. */
  private dedup(tools: ToolLike[]): ToolLike[] {
    const seen = new Set<string>();
    const deduped: ToolLike[] = [];
    for (const tool of tools) {
      const key = JSON.stringify(tool);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(tool);
    }
    return deduped.length === tools.length ? tools : deduped;
  }

  /** Deterministic name order; returns the same array when already sorted. */
  private sortByName(tools: ToolLike[]): ToolLike[] {
    const byName = [...tools];
    byName.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    return JSON.stringify(byName) === JSON.stringify(tools) ? tools : byName;
  }

  /** Move a trailing cache_control marker onto the new last tool. */
  private repinMarker(tools: ToolLike[], marker: unknown): ToolLike[] {
    const stripped = tools.map((t) => {
      if (t.cache_control === undefined) return t;
      const cleaned = { ...t };
      delete cleaned.cache_control;
      return cleaned;
    });
    const last = { ...stripped[stripped.length - 1] };
    last.cache_control = marker;
    stripped[stripped.length - 1] = last;
    return stripped;
  }

  /** Track byte-stability of the prefix-relevant head (tools + leading system). */
  private noteHead(body: Record<string, unknown>): void {
    const messages = (body.messages as Array<{ role: string; content: unknown }>) ?? [];
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          model: body.model,
          sys: messages
            .filter((m) => m.role === "system" || m.role === "developer")
            .slice(0, 2)
            .map((m) => m.content),
          tools: body.tools,
        }),
      )
      .digest("hex")
      .slice(0, 12);
    if (this.lastHeadHash !== "" && hash !== this.lastHeadHash) this.churnCount++;
    this.lastHeadHash = hash;
  }

  /** How many times the prefix head changed within this session. */
  churn(): number {
    return this.churnCount;
  }
}