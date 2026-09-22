/**
 * pi-cache — provider-aware cache TTL resolver tests.
 * Priority order (env override > learned knee > static profile > global
 * default), the per-provider static profiles, and the learned-value bounds.
 */

import { test, assert, assertEq } from "./harness.ts";
import { ProviderTtlResolver } from "../src/provider-ttl.ts";
import { TtlLearner } from "../src/ttl-learner.ts";

function ctxOf(model?: string, provider?: string) {
  return { model: { id: model, provider } };
}

test("resolver: per-provider static profiles and the global default", () => {
  const resolver = new ProviderTtlResolver({});
  assertEq(resolver.resolveSeconds(ctxOf("claude-sonnet-4-5", "anthropic")), 300);
  assertEq(resolver.resolveSeconds(ctxOf("gpt-5.2", "openai")), 1800);
  assertEq(resolver.resolveSeconds(ctxOf("kimi-k2", "moonshot")), 300);
  assertEq(resolver.resolveSeconds(ctxOf("deepseek-chat", "deepseek")), 14400);
  assertEq(resolver.resolveSeconds(ctxOf("z-ai/glm-4.6", "openrouter")), 120);
  assertEq(resolver.resolveSeconds(ctxOf("glm-4.6", "z-ai")), 120);
  assertEq(resolver.resolveSeconds(ctxOf("gemini-3-pro", "google")), 300);
  assertEq(resolver.resolveSeconds(ctxOf("unknown-model", "mystery")), 300);
  assertEq(resolver.resolveSeconds(undefined), 300);
});

test("resolver: an explicit PI_CACHE_TTL_SECONDS beats every profile", () => {
  const resolver = new ProviderTtlResolver(
    { PI_CACHE_TTL_SECONDS: "77" },
    { learner: undefined },
  );
  assertEq(resolver.resolveSeconds(ctxOf("z-ai/glm-4.6", "openrouter")), 77);
  assertEq(resolver.resolveSeconds(ctxOf("deepseek-chat", "deepseek")), 77);
  // Unparsable or non-positive values fall back to the profile.
  assertEq(new ProviderTtlResolver({ PI_CACHE_TTL_SECONDS: "nope" }).resolveSeconds(undefined), 300);
  assertEq(new ProviderTtlResolver({ PI_CACHE_TTL_SECONDS: "0" }).resolveSeconds(undefined), 300);
});

test("resolver: consults the learner, floored at 60 s", () => {
  const learner = new TtlLearner();
  const resolver = new ProviderTtlResolver({}, { learner });
  // GLM hits at 30 s gaps: largest hit gap is 30 s, floored to 60 s.
  const base = 1_000_000;
  for (let i = 0; i < 5; i++) {
    learner.note({
      id: `r${i}`,
      seq: i,
      ts: base + i * 30_000,
      pid: 1,
      session: "s",
      model: "z-ai/glm-4.6",
      input: 5000,
      output: 10,
      cacheRead: i === 0 ? 0 : 4000,
      cacheWrite: i === 0 ? 1000 : 0,
      totalTokens: 5000,
    });
  }
  assertEq(resolver.resolveSeconds(ctxOf("z-ai/glm-4.6", "openrouter")), 60);
});

test("resolver: learned knees are bounded by the static profile and the floor", () => {
  const learner = new TtlLearner();
  const base = 2_000_000;
  // Five GLM hits at 500 s gaps: raw knee 500 s, but the GLM static
  // profile (120 s) caps the resolved value and the env override still wins.
  for (let i = 0; i < 6; i++) {
    learner.note({
      id: `b${i}`,
      seq: i,
      ts: base + i * 500_000,
      pid: 1,
      session: "s",
      model: "glm-4.6",
      input: 5000,
      output: 1,
      cacheRead: i === 0 ? 0 : 5000,
      cacheWrite: i === 0 ? 5000 : 0,
      totalTokens: 5000,
    });
  }
  const resolver = new ProviderTtlResolver({}, { learner });
  assertEq(resolver.resolveSeconds(ctxOf("glm-4.6", "z-ai")), 120);
  assertEq(
    new ProviderTtlResolver({ PI_CACHE_TTL_SECONDS: "90" }, { learner }).resolveSeconds(
      ctxOf("glm-4.6", "z-ai"),
    ),
    90,
  );
});

test("resolver: injectable model/provider getters are honored", () => {
  const resolver = new ProviderTtlResolver(
    {},
    {
      modelIdOf: () => "deepseek-chat",
      providerIdOf: () => "deepseek",
    },
  );
  assertEq(resolver.resolveSeconds({ model: { id: "whatever" } }), 14400);
});