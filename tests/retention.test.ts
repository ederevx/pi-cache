/**
 * pi-cache — retention rewrite tests.
 * The rewrite upgrades every existing marker to the 1h tier and OpenAI
 * payloads to 24h retention; it must never touch markers on disabled
 * runs, stay idempotent, and report the effective tier.
 */

import { test, assert, assertEq } from "./harness.ts";
import { RetentionRewriter } from "../src/retention.ts";

const MARKER = Object.freeze({ type: "ephemeral" });

function anthropicPayload() {
  const lastUser = { role: "user", content: [{ type: "text", text: "hi", cache_control: { ...MARKER } }] };
  return {
    model: "claude-x",
    system: [{ type: "text", text: "sys", cache_control: { ...MARKER } }],
    tools: [{ name: "t", input_schema: {}, cache_control: { ...MARKER } }],
    messages: [lastUser],
  };
}

function openaiPayload() {
  return {
    model: "gpt-5",
    prompt_cache_key: "abc",
    messages: [{ role: "system", content: "sys" }],
  };
}

test("retention: upgrades every anthropic marker to the 1h tier", () => {
  const rewriter = new RetentionRewriter(true);
  const p = anthropicPayload();
  rewriter.apply(p);
  for (const block of [
    (p.system as Array<Record<string, unknown>>)[0],
    (p.tools as Array<Record<string, unknown>>)[0],
    (p.messages[0].content as Array<Record<string, unknown>>)[0],
  ]) {
    assertEq(JSON.stringify(block.cache_control), JSON.stringify({ type: "ephemeral", ttl: "1h" }));
  }
  assertEq(rewriter.effectiveLong(), true);
});

test("retention: upgrades openai payloads carrying a prompt_cache_key", () => {
  const rewriter = new RetentionRewriter(true);
  const p = openaiPayload();
  rewriter.apply(p);
  assertEq(p.prompt_cache_retention, "24h");
  assertEq(rewriter.effectiveLong(), true);
});

test("retention: leaves payloads without markers or keys unknown", () => {
  const rewriter = new RetentionRewriter(true);
  const p = { model: "glm", messages: [{ role: "user", content: "hi" }] };
  rewriter.apply(p);
  assertEq(rewriter.effectiveLong(), undefined, "no provider proof, no tier claim");
});

test("retention: disabled rewrites nothing", () => {
  const rewriter = new RetentionRewriter(false);
  const p = anthropicPayload();
  const o = openaiPayload();
  rewriter.apply(p);
  rewriter.apply(o);
  assertEq(
    JSON.stringify((p.system as Array<Record<string, unknown>>)[0].cache_control),
    JSON.stringify(MARKER),
    "marker untouched",
  );
  assertEq(o.prompt_cache_retention, undefined);
  assertEq(rewriter.effectiveLong(), undefined);
});

test("retention: idempotent on an already-long payload", () => {
  const rewriter = new RetentionRewriter(true);
  const p = anthropicPayload();
  rewriter.apply(p);
  const first = JSON.stringify(p);
  rewriter.apply(p);
  assertEq(JSON.stringify(p), first, "second pass changes nothing");
});

test("retention: an already-24h payload still reports the long tier", () => {
  const rewriter = new RetentionRewriter(true);
  const p = { model: "gpt-5", prompt_cache_key: "k", prompt_cache_retention: "24h", messages: [] };
  rewriter.apply(p);
  assertEq(rewriter.effectiveLong(), true, "wire already long, report long");
});
