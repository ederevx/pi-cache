/**
 * pi-cache — provider-aware cache lifetime tests.
 * The model in use must map onto its documented provider TTL so the
 * coldness ramp and idle timer measure against the real lifetime.
 */

import { test, assertEq } from "./harness.ts";
import { ModelTtl } from "../src/model-ttl.ts";

const ttl = new ModelTtl();

test("model-ttl: documented provider profiles", () => {
  assertEq(ttl.secondsFor("anthropic", "claude-sonnet-4"), 300);
  assertEq(ttl.secondsFor("anthropic", "claude-sonnet-4", true), 3600, "long tier");
  assertEq(ttl.secondsFor("openai", "gpt-4o"), 1800);
  assertEq(ttl.secondsFor("z-ai", "glm-4.6"), 120);
  assertEq(ttl.secondsFor("deepseek", "deepseek-chat"), 14400);
  assertEq(ttl.secondsFor("google", "gemini-2.5-flash"), 300);
  assertEq(ttl.secondsFor("moonshot", "kimi-k2"), 300);
});

test("model-ttl: matches the model-id prefix when the provider is generic", () => {
  assertEq(ttl.secondsFor(undefined, "anthropic/claude-sonnet-4"), 300);
  assertEq(ttl.secondsFor("openrouter", "z-ai/glm-4.6"), 120);
  assertEq(ttl.secondsFor("openrouter", "openai/gpt-4o"), 1800);
});

test("model-ttl: unknown models defer to the caller's static fallback", () => {
  assertEq(ttl.secondsFor("meta", "llama-4"), undefined);
  assertEq(ttl.secondsFor(undefined, undefined), undefined);
});
