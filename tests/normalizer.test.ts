/**
 * pi-cache — prefix normalizer tests.
 * normalize() must sort/dedup tools deterministically, re-pin a trailing
 * Anthropic cache_control marker to the new last tool, leave a mid-array
 * explicit breakpoint untouched, and count prefix-head churn.
 */

import { test, assert, assertEq, assertDeepEq } from "./harness.ts";
import { PrefixNormalizer } from "../src/normalizer.ts";

function makeTool(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, description: `tool ${name}`, ...extra };
}

test("normalizer: sorts tools deterministically", () => {
  const n = new PrefixNormalizer({ sortTools: true, dedupTools: false });
  const payload = {
    model: "m",
    messages: [{ role: "system", content: "sys" }],
    tools: [makeTool("zeta"), makeTool("alpha"), makeTool("mid")],
  };
  const out = n.normalize(payload) as typeof payload;
  assertEq(out, payload, "same object reference returned");
  assertDeepEq(
    (out.tools as unknown[]).map((t) => (t as { name: string }).name),
    ["alpha", "mid", "zeta"],
    "tools sorted by name",
  );
});

test("normalizer: dedups exact-duplicate tools", () => {
  const n = new PrefixNormalizer({ sortTools: false, dedupTools: true });
  const payload = {
    model: "m",
    messages: [],
    tools: [makeTool("a"), makeTool("a"), makeTool("b"), makeTool("a")],
  };
  const out = n.normalize(payload) as typeof payload;
  assertEq((out.tools as unknown[]).length, 2, "duplicates removed");
});

test("normalizer: re-pins trailing cache_control marker after sort", () => {
  const n = new PrefixNormalizer({ sortTools: true, dedupTools: true });
  const payload = {
    model: "m",
    messages: [],
    tools: [
      makeTool("b"),
      makeTool("a"),
      makeTool("c", { cache_control: { type: "ephemeral" } }),
    ],
  };
  const out = n.normalize(payload) as typeof payload;
  const tools = out.tools as Array<Record<string, unknown>>;
  assertDeepEq(tools.map((t) => t.name), ["a", "b", "c"], "sorted");
  // Marker survives exactly once, on the LAST tool.
  const marked = tools.filter((t) => t.cache_control !== undefined);
  assertEq(marked.length, 1, "exactly one marker");
  assertEq(tools[tools.length - 1].name, "c", "marker on last tool");
});

test("normalizer: mid-array explicit breakpoint is left alone", () => {
  const n = new PrefixNormalizer({ sortTools: true, dedupTools: true });
  const tools = [
    makeTool("b"),
    makeTool("a", { cache_control: { type: "ephemeral" } }),
    makeTool("c"),
  ];
  const payload = { model: "m", messages: [], tools };
  const out = n.normalize(payload) as typeof payload;
  assertEq(out, payload, "unchanged payload identity (no transform)");
  assertDeepEq(out.tools, tools, "tools untouched");
});

test("normalizer: unchanged input returns the same reference", () => {
  const n = new PrefixNormalizer({ sortTools: true, dedupTools: true });
  const payload = { model: "m", messages: [], tools: [makeTool("a"), makeTool("b")] };
  assertEq(n.normalize(payload), payload, "already sorted/deduped stays identical");
});

test("normalizer: non-object payloads pass through", () => {
  const n = new PrefixNormalizer({ sortTools: true, dedupTools: true });
  assertEq(n.normalize(null), null);
  assertEq(n.normalize(undefined), undefined);
  assertEq(n.normalize("x"), "x");
  const noTools = { model: "m" };
  assertEq(n.normalize(noTools), noTools, "no tools array → unchanged object returned");});

test("normalizer: churn counts head changes, first observation is baseline", () => {
  const n = new PrefixNormalizer({ sortTools: false, dedupTools: false });
  const head = (model: string) => ({ model, messages: [{ role: "system", content: "sys" }], tools: [] });
  n.normalize(head("a"));
  assertEq(n.churn(), 0, "first call is the baseline");
  n.normalize(head("a"));
  assertEq(n.churn(), 0, "identical head does not churn");
  n.normalize(head("b"));
  assertEq(n.churn(), 1, "model change counts one churn");
});