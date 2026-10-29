/**
 * pi-cache — provider-aware cache lifetime tests.
 * The model in use must map onto its documented provider TTL so the
 * coldness ramp and idle timer measure against the real lifetime, and the
 * profile table must be replaceable without a code change.
 */

import { test, assertEq } from "./harness.ts";
import { ModelTtl, type TtlProfile } from "../src/model-ttl.ts";
import { OptionsLoader } from "../src/constants.ts";

const defaults = (): readonly TtlProfile[] => new OptionsLoader({}).load().cacheTtlProfiles;
const ttl = new ModelTtl(defaults());

test("model-ttl: documented provider profiles", () => {
  assertEq(ttl.secondsFor("anthropic", ""), 300);
  assertEq(ttl.secondsFor("anthropic", "", true), 3600, "long tier");
  assertEq(ttl.secondsFor("openai", "gpt-4o"), 1800);
  assertEq(ttl.secondsFor("z-ai", "glm-4.6"), 120);
  assertEq(ttl.secondsFor("deepseek", "deepseek-chat"), 1800);
  assertEq(ttl.secondsFor("deepseek", "deepseek-chat", true), 1800, "long tier");
  assertEq(ttl.secondsFor("google", "gemini-2.5-flash"), 300);
  assertEq(ttl.secondsFor("moonshot", "kimi-k2"), 300);
});

test("model-ttl: matches the model-id prefix when the provider is generic", () => {
  assertEq(ttl.secondsFor(undefined, "anthropic/"), 300);
  assertEq(ttl.secondsFor("openrouter", "z-ai/glm-4.6"), 120);
  assertEq(ttl.secondsFor("openrouter", "openai/gpt-4o"), 1800);
});

test("model-ttl: unknown models defer to the caller's static fallback", () => {
  assertEq(ttl.secondsFor("meta", "llama-4"), undefined);
  assertEq(ttl.secondsFor(undefined, undefined), undefined);
});

test("model-ttl: the profile table is configuration, not code", () => {
  const profiles = new OptionsLoader({
    PI_CACHE_TTL_PROFILES: "Meta=900;some-gateway,other=60,7200",
  }).load().cacheTtlProfiles;
  const custom = new ModelTtl(profiles);
  assertEq(custom.secondsFor("meta", "llama-4"), 900);
  assertEq(custom.secondsFor("meta", "llama-4", true), 900, "a single lifetime covers both tiers");
  assertEq(custom.secondsFor("some-gateway", ""), 60);
  assertEq(custom.secondsFor("other", "", true), 7200);
  assertEq(custom.secondsFor("anthropic", ""), undefined, "the override replaces the table");
});

test("model-ttl: an empty override leaves only the declared tier and the fallback", () => {
  const profiles = new OptionsLoader({ PI_CACHE_TTL_PROFILES: "  " }).load().cacheTtlProfiles;
  assertEq(profiles.length, 0);
  assertEq(new ModelTtl(profiles).secondsFor("anthropic", ""), undefined);
});

test("model-ttl: a malformed override keeps the default table", () => {
  for (const raw of ["anthropic", "anthropic=", "anthropic=0", "anthropic=1800junk", "=300", "a=1,2,3", "a=1;b"]) {
    const profiles = new OptionsLoader({ PI_CACHE_TTL_PROFILES: raw }).load().cacheTtlProfiles;
    assertEq(profiles.length, 6, `default table kept for ${JSON.stringify(raw)}`);
    assertEq(new ModelTtl(profiles).secondsFor("anthropic", ""), 300);
  }
});
