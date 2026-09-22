/**
 * pi-cache — shared prompt_cache_key and forced-warming policy tests.
 * The sharer replaces pi's per-session key with a head-derived stable key
 * only where pi already set one; the policy answers warm only when forced.
 */

import { test, assert, assertEq, assertMatches } from "./harness.ts";
import { CacheKeySharer } from "../src/cache-key.ts";

function openaiPayload(tools: unknown) {
  return {
    model: "gpt-5",
    prompt_cache_key: "session-uuid",
    messages: [{ role: "system", content: "shared system" }],
    tools,
  };
}

test("cache-key: derives a stable shared key from the prefix head", () => {
  const sharer = new CacheKeySharer(true);
  const a = openaiPayload([{ name: "t" }]);
  const b = openaiPayload([{ name: "t" }]);
  sharer.apply(a);
  sharer.apply(b);
  assertEq(a.prompt_cache_key, b.prompt_cache_key, "same head, same bucket");
  assertMatches(a.prompt_cache_key as string, /^pi-cache-[0-9a-f]{24}$/);
});

test("cache-key: different heads derive different keys", () => {
  const sharer = new CacheKeySharer(true);
  const a = openaiPayload([{ name: "t" }]);
  const b = openaiPayload([{ name: "other" }]);
  sharer.apply(a);
  sharer.apply(b);
  assert(a.prompt_cache_key !== b.prompt_cache_key, "head divergence re-buckets");
});

test("cache-key: payloads without a prompt_cache_key are untouched", () => {
  const sharer = new CacheKeySharer(true);
  const p = { model: "gpt-5", messages: [{ role: "system", content: "s" }] };
  sharer.apply(p);
  assertEq(p.prompt_cache_key, undefined);
});

test("cache-key: disabled keeps pi's own key", () => {
  const sharer = new CacheKeySharer(false);
  const p = openaiPayload([]);
  sharer.apply(p);
  assertEq(p.prompt_cache_key, "session-uuid");
});
