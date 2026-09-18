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
    let changed = false;

    if (this.opts.dedupTools) {
      const seen = new Set<string>();
      const deduped: ToolLike[] = [];
      for (const tool of tools) {
        const key = JSON.stringify(tool);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(tool);
      }
      if (deduped.length !== tools.length) {
        body.tools = deduped;
        changed = true;
      }
    }

    if (this.opts.sortTools) {
      const byName = [...(body.tools as ToolLike[])];
      byName.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
      if (JSON.stringify(byName) !== JSON.stringify(body.tools)) {
        body.tools = byName;
        changed = true;
      }
    }
    return changed;
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