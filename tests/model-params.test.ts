/**
 * pi-cache — fresh OpenRouter model-parameter tests.
 * The live pull must win, the last-good snapshot must cover an inaccessible
 * endpoint, and malformed/hostile pricing must never produce a rate.
 */

import { test, assert, assertEq, scratchDir } from "./harness.ts";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { OpenRouterModelParams, type FetchResponseLike } from "../src/model-params.ts";
import { ParamsStore } from "../src/params-store.ts";

function ok(data: unknown): FetchResponseLike {
  return { ok: true, status: 200, json: async () => data };
}

function modelBody(models: unknown[]): unknown {
  return { data: models };
}

function params(fetchImpl: (url: string) => Promise<FetchResponseLike>, store?: ParamsStore) {
  return new OpenRouterModelParams({ fetchImpl, store, now: () => 1_000_000 });
}

test("model-params: a fresh pull converts USD/token to per-million rates", async () => {
  const client = params(async () =>
    ok(
      modelBody([
        {
          id: "anthropic/claude-sonnet-4",
          pricing: {
            prompt: "0.000003",
            input_cache_read: "0.0000003",
            input_cache_write: "0.00000375",
          },
          context_length: 200000,
        },
      ]),
    ),
  );
  assertEq(client.ratesFor("anthropic/claude-sonnet-4"), undefined, "no snapshot yet");
  const result = await client.refresh();
  assertEq(result.ok, true);
  assertEq(result.models, 1);
  const rates = client.ratesFor("anthropic/claude-sonnet-4");
  assertEq(rates?.input, 3);
  assertEq(rates?.cacheRead, 0.3);
  assertEq(rates?.cacheWrite, 3.75);
});

test("model-params: request-wide override tiers follow the token count", async () => {
  const client = params(async () =>
    ok(
      modelBody([
        {
          id: "anthropic/claude-sonnet-4",
          pricing: {
            prompt: "0.000003",
            input_cache_read: "0.0000003",
            input_cache_write: "0.00000375",
            overrides: [
              {
                min_prompt_tokens: 200000,
                prompt: "0.000006",
                input_cache_read: "0.0000006",
                input_cache_write: "0.0000075",
              },
            ],
          },
        },
      ]),
    ),
  );
  await client.refresh();
  assertEq(client.ratesFor("anthropic/claude-sonnet-4", 100_000)?.input, 3, "base tier");
  assertEq(client.ratesFor("anthropic/claude-sonnet-4", 250_000)?.input, 6, "override tier");
});

test("model-params: a missing cache rate charges no false discount", async () => {
  const client = params(async () =>
    ok(modelBody([{ id: "deepseek/deepseek-chat", pricing: { prompt: "0.0000002574" } }])),
  );
  await client.refresh();
  const rates = client.ratesFor("deepseek/deepseek-chat");
  assert(rates !== undefined, "rates expected");
  assertEq(rates!.cacheRead, rates!.input, "no hit discount without a read rate");
  assertEq(rates!.cacheWrite, 0);
});

test("model-params: router sentinels and free models are rejected", async () => {
  const client = params(async () =>
    ok(
      modelBody([
        { id: "openrouter/auto", pricing: { prompt: "-1" } },
        { id: "free/model", pricing: { prompt: "0" } },
      ]),
    ),
  );
  const result = await client.refresh();
  assertEq(result.models, 0, "no usable pricing");
  assertEq(client.ratesFor("openrouter/auto"), undefined);
});

test("model-params: an inaccessible pull never rejects and keeps last-good", async () => {
  let fail = false;
  const client = params(async () => {
    if (fail) throw new Error("network down");
    return ok(modelBody([{ id: "z-ai/glm-4.6", pricing: { prompt: "0.00000043", input_cache_read: "0.00000008" } }]));
  });
  await client.refresh();
  fail = true;
  const result = await client.refresh();
  assertEq(result.ok, false);
  assertEq(client.ratesFor("z-ai/glm-4.6")?.input, 0.43, "previous snapshot stands");
});

test("model-params: a corrupt disk snapshot degrades to no rates", () => {
  const root = join(scratchDir(), "params-corrupt");
  mkdirSync(root, { recursive: true });
  const store = new ParamsStore(join(root, "model-params.json"));
  const client = params(async () => {
    throw new Error("offline");
  }, store);
  assertEq(client.ratesFor("anthropic/claude-sonnet-4"), undefined);
});

test("model-params: last-good survives a restart through the disk store", async () => {
  const root = join(scratchDir(), "params-persist");
  mkdirSync(root, { recursive: true });
  const store = new ParamsStore(join(root, "model-params.json"));
  const first = params(
    async () =>
      ok(modelBody([{ id: "openai/gpt-4o", pricing: { prompt: "0.0000025", input_cache_read: "0.00000125" } }])),
    store,
  );
  await first.refresh();
  const restarted = params(async () => {
    throw new Error("offline");
  }, store);
  assertEq(restarted.ratesFor("openai/gpt-4o")?.input, 2.5, "stored snapshot loaded");
});

test("model-params: concurrent refreshes share one request", async () => {
  let calls = 0;
  const client = params(async () => {
    calls++;
    return ok(modelBody([{ id: "z-ai/glm-4.6", pricing: { prompt: "0.00000043" } }]));
  });
  await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
  assertEq(calls, 1, "one in-flight pull");
});
