/**
 * pi-cache — provider-aware cache TTL resolver.
 *
 * One responsibility: resolve the effective provider cache lifetime for a
 * request. Priority order: an explicit `PI_CACHE_TTL_SECONDS` env override
 * beats everything (the hard override, unchanged from the global-only
 * behavior); otherwise the per-provider static profile below; otherwise the
 * global 300 s default. When a `TtlLearner` is present its empirical knee
 * refines the static profile, bounded so measurement can only tighten the
 * documented value, never raise it. The model/provider ids are read through
 * injectable getters so tests never need a real handler context.
 */

import type { TtlLearner } from "./ttl-learner.ts";

/** The context slice the resolver reads (loose view over pi's ctx.model). */
export interface ProviderTtlContextView {
  model?: { id?: string; provider?: string };
}

export interface ProviderTtlResolverOptions {
  /** Learner-provided empirical knees, when one is wired. */
  learner?: TtlLearner;
  /** Global fallback when no profile matches (default 300 s). */
  defaultSeconds?: number;
  /** Injectable model-id getter (default: `ctx.model.id`). */
  modelIdOf?: (ctx: unknown) => string | undefined;
  /** Injectable provider-id getter (default: `ctx.model.provider`). */
  providerIdOf?: (ctx: unknown) => string | undefined;
}

/** One static provider profile: match tokens, TTL, and its source. */
interface ProviderTtlProfile {
  /** Case-insensitive substrings matched against `${provider} ${model}`. */
  matches: readonly string[];
  seconds: number;
  why: string;
}

export class ProviderTtlResolver {
  /** Learned knees never drop below this floor: a couple of flap hits at a
   *  2-16 s gap must not be read as a 2 s cache lifetime. */
  static readonly LEARNED_FLOOR_SECONDS = 60;

  private static readonly GLOBAL_DEFAULT_SECONDS = 300;
  private static readonly ENV_NAME = "PI_CACHE_TTL_SECONDS";

  /** Ordered profiles; the first matching substring wins. GLM sorts before
   *  the generic defaults because its TTL is the only empirically measured
   *  short one; every other entry is keyed on its provider or model token
   *  (model ids usually carry the same token, e.g. `z-ai/glm-4.6`). */
  private static readonly PROFILES: readonly ProviderTtlProfile[] = [
    {
      matches: ["anthropic"],
      seconds: 300,
      why:
        "Anthropic prompt caching: 5 min default, 1 h option, a hit " +
        "refreshes the TTL (docs.claude.com; docs/research/" +
        "internet-prompt-caching-2026-09-18.md).",
    },
    {
      matches: ["openai"],
      seconds: 1800,
      why:
        "OpenAI: cached prefixes persist >=30 min and are refreshed on " +
        "reuse (platform.openai.com caching docs).",
    },
    {
      matches: ["moonshot", "kimi"],
      seconds: 300,
      why:
        "Moonshot Kimi context caching: 5 min tier default (1 h tier " +
        "exists), refreshed on hit (platform.moonshot.ai docs).",
    },
    {
      matches: ["deepseek"],
      seconds: 14400,
      why:
        "DeepSeek: no documented TTL - entries are 'usually cleared within " +
        "a few hours to a few days'; 4 h is the conservative midpoint " +
        "(api-docs.deepseek.ai).",
    },
    {
      matches: ["z-ai", "glm"],
      seconds: 120,
      why:
        "GLM (z.ai, incl. via OpenRouter): cache TTL undocumented; a " +
        "647-call pi-cache audit through OpenRouter measured an empirical " +
        "knee near 126 s, so 120 s is the conservative profile.",
    },
    {
      matches: ["google", "gemini"],
      seconds: 300,
      why:
        "Gemini implicit caching: ~5 min default lifetime (ai.google.dev " +
        "context-caching docs; same figure in docs/research/).",
    },
  ];

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly opts: ProviderTtlResolverOptions = {},
  ) {}

  /** The effective cache TTL (s): env override > learned knee > static
   *  profile > global default. Total across every path. */
  resolveSeconds(ctx: unknown): number {
    const override = this.envOverrideSeconds();
    if (override !== undefined) return override;
    const staticSeconds = this.staticSeconds(ctx);
    return this.learnedSeconds(ctx, staticSeconds) ?? staticSeconds;
  }

  /** The static (profile-or-default) TTL without the learner, for callers
   *  that need the documented value (tests, bounds). */
  staticSeconds(ctx: unknown): number {
    const key = this.providerModelKey(ctx);
    for (const profile of ProviderTtlResolver.PROFILES) {
      if (profile.matches.some((token) => key.includes(token))) {
        return profile.seconds;
      }
    }
    return this.opts.defaultSeconds ?? ProviderTtlResolver.GLOBAL_DEFAULT_SECONDS;
  }

  /** The explicit env override, or undefined when unset/unparsable. */
  private envOverrideSeconds(): number | undefined {
    const raw = this.env[ProviderTtlResolver.ENV_NAME];
    if (raw === undefined || raw === "") return undefined;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  /** The learner's knee bounded to [floor, static]; never above the static
   *  profile so a fluke large-gap hit cannot extend the real lifetime. */
  private learnedSeconds(ctx: unknown, staticSeconds: number): number | undefined {
    const learned = this.opts.learner?.estimate(this.modelId(ctx) ?? "");
    if (learned === undefined) return undefined;
    return Math.min(
      Math.max(learned, ProviderTtlResolver.LEARNED_FLOOR_SECONDS),
      staticSeconds,
    );
  }

  /** Lowercased `provider model` search key for profile matching. */
  private providerModelKey(ctx: unknown): string {
    return `${this.providerId(ctx) ?? ""} ${this.modelId(ctx) ?? ""}`.toLowerCase();
  }

  private modelId(ctx: unknown): string | undefined {
    if (this.opts.modelIdOf) return this.opts.modelIdOf(ctx);
    const view = ctx as ProviderTtlContextView | undefined;
    return view?.model?.id;
  }

  private providerId(ctx: unknown): string | undefined {
    if (this.opts.providerIdOf) return this.opts.providerIdOf(ctx);
    const view = ctx as ProviderTtlContextView | undefined;
    return view?.model?.provider;
  }
}