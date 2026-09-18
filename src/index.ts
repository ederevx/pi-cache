/**
 * pi-cache — prompt-cache hit-rate optimizer for pi.
 *
 * Pillars (see docs/design.md):
 *   1. telemetry-first: per-request cacheRead/cacheWrite/cost ledger,
 *      always on; the other features are opt-in via config.
 *   2. stable-prefix normalization: byte-stable head, opt-in.
 *   3. tool-schema hygiene: deterministic sort/dedup, opt-in.
 *   4. cache-aware compaction advisory: observational only for now.
 *
 * Safety contract: every handler degrades to a no-op on any error, so the
 * extension can never break a request; no semantic rewrite happens unless
 * the config turns it on; nothing is sent to the LLM except what pi sends.
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface PiCacheConfig {
  enabled: boolean;
  telemetryJsonl: string; // absolute path; default ~/.pi/agent/pi-cache.jsonl
  sortTools: boolean; // deterministic tool order (opt-in)
  dedupTools: boolean; // exact-schema dedup (opt-in)
  normalizeSystemPrefix: boolean; // strip volatile lead lines (opt-in, off)
  volatileLinePrefixes: string[]; // lead-line prefixes to drop when normalizing
  compactAdvisory: boolean; // log compaction suggestions only
  minCacheMissNoticeTokens: number;
}

interface UsageRow {
  ts: number;
  seq: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

const DEFAULTS: PiCacheConfig = {
  enabled: true,
  telemetryJsonl: join(os.homedir(), ".pi", "agent", "pi-cache.jsonl"),
  sortTools: false,
  dedupTools: false,
  normalizeSystemPrefix: false,
  volatileLinePrefixes: ["Date:", "Current time"],
  compactAdvisory: true,
  minCacheMissNoticeTokens: 1024,
};

/**
 * Single owner of pi-cache state. Each method does one thing; the hook
 * wiring in the factory only forwards events here.
 */
class PiCache {
  private readonly cfg: PiCacheConfig;
  private rows: UsageRow[] = [];
  private seq = 0;
  private lastHeadHash = "";
  private headChurnCount = 0;

  constructor(cfg: PiCacheConfig) {
    this.cfg = cfg;
  }

  /** Load config; write a default template on first run. */
  static async load(): Promise<PiCacheConfig> {
    const dir = join(os.homedir(), ".pi", "agent");
    const path = join(dir, "pi-cache.json");
    try {
      const raw = await readFile(path, "utf8");
      return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PiCacheConfig>) };
    } catch {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(path, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf8");
      } catch {
        /* read-only environments: degrade to defaults */
      }
      return { ...DEFAULTS };
    }
  }

  /** Record one completed request's usage (from message_end). */
  recordUsage(
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    },
    model: string,
  ): void {
    if (!this.cfg.enabled) return;
    const row: UsageRow = {
      ts: Date.now(),
      seq: this.seq++,
      model,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
    };
    this.rows.push(row);
    void this.persist(row);
  }

  private async persist(row: UsageRow): Promise<void> {
    try {
      await appendFile(this.cfg.telemetryJsonl, JSON.stringify(row) + "\n", "utf8");
    } catch {
      /* telemetry must never break the session */
    }
  }

  private totals(): { input: number; cacheRead: number; cacheWrite: number; n: number } {
    return this.rows.reduce(
      (a, r) => ({
        input: a.input + r.input,
        cacheRead: a.cacheRead + r.cacheRead,
        cacheWrite: a.cacheWrite + r.cacheWrite,
        n: a.n + 1,
      }),
      { input: 0, cacheRead: 0, cacheWrite: 0, n: 0 },
    );
  }

  /** Summary text for /pi-cache and the status widget. */
  summary(): string {
    const t = this.totals();
    if (t.n === 0) return "pi-cache: no usage recorded yet";
    const denom = t.input + t.cacheRead;
    const ratio = denom > 0 ? t.cacheRead / denom : 0;
    return (
      `pi-cache: ${t.n} req, read ${t.cacheRead.toLocaleString()} / ` +
      `in ${t.input.toLocaleString()} (${(ratio * 100).toFixed(1)}%)` +
      `, writes ${t.cacheWrite.toLocaleString()}, head churn ${this.headChurnCount}`
    );
  }

  /**
   * Opt-in prefix transforms on the provider-serialized payload. Returns
   * undefined (keep) or a replacement payload. Only the tools array is
   * reordered/deduped; conversation messages are never touched.
   */
  normalizePayload(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const body = payload as Record<string, unknown>;
    if (Array.isArray(body.tools)) {
      const tools = body.tools as Record<string, unknown>[];
      let changed = false;

      if (this.cfg.dedupTools) {
        const seen = new Set<string>();
        const deduped: Record<string, unknown>[] = [];
        for (const t of tools) {
          const key = JSON.stringify(t);
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(t);
        }
        if (deduped.length !== tools.length) {
          body.tools = deduped;
          changed = true;
        }
      }

      if (this.cfg.sortTools) {
        const byName = [...(body.tools as Record<string, unknown>[])];
        byName.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
        if (JSON.stringify(byName) !== JSON.stringify(body.tools)) {
          body.tools = byName;
          changed = true;
        }
      }

      if (!changed) return payload;
    }

    const hash = this.headHash(body);
    if (this.lastHeadHash !== "" && hash !== this.lastHeadHash) this.headChurnCount++;
    this.lastHeadHash = hash;
    return payload;
  }

  /** Deterministic hash of the prefix-relevant head (tools + leading system/developer). */
  private headHash(body: Record<string, unknown>): string {
    const messages = (body.messages as Array<{ role: string; content: unknown }>) ?? [];
    return createHash("sha256")
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
  }

  /** Observational compaction advisory: log, never auto-cancel by default. */
  compactAdvisorySuggestion(entryCount: number, tokensBefore: number): string | undefined {
    if (!this.cfg.compactAdvisory) return undefined;
    const t = this.totals();
    const denom = t.input + t.cacheRead;
    if (t.n > 0 && denom > 0 && t.cacheRead / denom >= 0.6 && tokensBefore > 50_000) {
      return (
        `pi-cache: warm cache (~${(100 * t.cacheRead / denom).toFixed(0)}%) with ` +
        `${entryCount} entries ahead of compaction; consider raising keepRecentTokens` +
        ` to avoid a full re-write`
      );
    }
    return undefined;
  }
}

export default async function factory(pi: ExtensionAPI) {
  const cfg = await PiCache.load();
  const cache = new PiCache(cfg);

  pi.on("message_end", async (event) => {
    try {
      const msg = event.message;
      if (msg?.role === "assistant" && msg.usage) {
        cache.recordUsage(
          {
            input: msg.usage.input ?? 0,
            output: msg.usage.output ?? 0,
            cacheRead: msg.usage.cacheRead ?? 0,
            cacheWrite: msg.usage.cacheWrite ?? 0,
            totalTokens: msg.usage.totalTokens ?? 0,
          },
          "current",
        );
      }
    } catch {
      /* never break the turn */
    }
  });

  pi.on("before_provider_request", async (event) => {
    try {
      if (!cfg.sortTools && !cfg.dedupTools) return event.payload;
      return cache.normalizePayload(event.payload);
    } catch {
      return event.payload;
    }
  });

  pi.on("session_before_compact", async (event) => {
    try {
      const tip = cache.compactAdvisorySuggestion(
        event.preparation.messagesToSummarize.length,
        event.preparation.tokensBefore,
      );
      if (tip) pi.appendEntry("pi-cache-advisory", { message: tip });
    } catch {
      /* advisory only */
    }
  });

  pi.registerCommand("cache-stats", {
    description: "Show pi-cache usage, cache ratio, and head churn",
    handler: async () => cache.summary(),
  });
}