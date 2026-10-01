/**
 * pi-cache — `pre_cache` onboarding tool.
 *
 * One responsibility: register the single `pre_cache` catalog tool and
 * hold the per-session first-call gate over pi-cache's own model-callable
 * tools. Tool rows use pi's native collapsed rendering, so the extension
 * blends in; Ctrl+O expands. The catalog is the only
 * model-facing summary of pi-cache; feature and tool lists live here
 * rather than in prompt snippets or long tool descriptions. pi-cache is
 * hook-driven and today registers no model-callable tools, so the gate
 * stays open and the catalog says so plainly.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export class PreCacheTool {
  private acknowledged = false;
  private readonly ownTools: ReadonlySet<string>;
  private readonly features: readonly string[];
  private readonly conventions: readonly string[];

  constructor(ownTools: readonly string[] = []) {
    this.ownTools = new Set(ownTools);
    this.features = [
      "Cache telemetry: per-turn usage rows with TTL, warm state, and tiers.",
      "Prefix normalization: exact-schema tool dedup and volatile-field removal.",
      "Prefix stability: head-churn tracking and a shared OpenAI cache key.",
      "Fast compaction: a byte-stable stub for every reason, an optional " +
        "dropped-span digest, and a branch summary.",
      "Warming: retention-aware refresh scheduling and a gated force-warm policy.",
      "Settings: PI_CACHE_* env vars plus the owned settings JSON.",
    ];
    this.conventions = [
      "pi-cache exposes no model-callable tools; it acts through lifecycle hooks.",
      "Read live state with /cache-stats and change options with " +
        "/cache-settings; do not edit the owned settings JSON mid-session.",
      "Fast compaction replaces pi's summarizer for every compaction " +
        "reason unless disabled in /cache-settings.",
    ];
  }

  /** Register the tool and the first-call gate. */
  register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "pre_cache",
      label: "pre_cache",
      description:
        "Call this once before using any pi-cache tool in a session. " +
        "Returns the pi-cache tool catalog, conventions, and feature summary.",
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true },
      execute: async () => {
        this.acknowledged = true;
        return {
          content: [{ type: "text", text: this.catalog() }],
          details: {
            tools: [...this.ownTools],
            conventions: this.conventions,
            features: this.features,
          },
        };
      },
    });

    pi.on("session_start", async () => {
      this.acknowledged = false;
    });

    pi.on("tool_call", async (event) => {
      const name = String(event.toolName ?? "");
      if (name === "pre_cache") {
        this.acknowledged = true;
        return;
      }
      if (this.acknowledged || !this.owns(name)) return;
      return {
        block: true,
        reason:
          "Call pre_cache first: it returns the pi-cache tool catalog and " +
          "conventions. Then retry this call.",
      };
    });
  }

  /** The model-facing catalog: tools, then conventions, then features. */
  catalog(): string {
    return [
      "pi-cache catalog",
      "",
      "Model-callable tools: none — pi-cache is hook-driven and registers",
      "no tools. Two user commands are available:",
      "  /cache-stats     global + session cache stats with live pressure",
      "  /cache-settings  edit every pi-cache option (restore/reset)",
      "",
      "Conventions:",
      ...this.conventions.map((line) => `- ${line}`),
      "",
      "Features:",
      ...this.features.map((line) => `- ${line}`),
    ].join("\n");
  }

  /** True only for pi-cache's own model-callable tools. */
  private owns(name: string): boolean {
    return this.ownTools.has(name);
  }
}
