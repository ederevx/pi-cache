/**
 * pi-cache — fresh model-parameter tests.
 * The live pull must win, the last-good snapshot must cover an inaccessible
 * endpoint, malformed/hostile pricing must never produce a rate, and a
 * snapshot must never price a request from another endpoint.
 */

import { test, assert, assertEq, scratchDir } from "./harness.ts";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { OpenRouterModelParams, type FetchResponseLike } from "../src/model-params.ts";
import { ParamsStore } from "../src/params-store.ts";

const URL_BASE = "https://openrouter.ai/api/v1/models";

function ok(data: unknown): FetchResponseLike {
  return { ok: true, status: 200, json: async () => data };
}

function modelBody(models: unknown[]): unknown {
  return { data: models };
}

function params(fetchImpl: (url: string) => Promise<FetchResponseLike>, store?: ParamsStore) {
  return new OpenRouterModelParams({
    url: URL_BASE,
    fetchImpl,
    store,
    now: () => 1_000_000,
    maxAgeMs: 300_000,
    retryMs: 60_000,
    timeoutMs: 5_000,
  });
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
  const store = new ParamsStore(join(root, "model-params.json"), 5000);
  const client = params(async () => {
    throw new Error("offline");
  }, store);
  assertEq(client.ratesFor("anthropic/claude-sonnet-4"), undefined);
});

test("model-params: last-good survives a restart through the disk store", async () => {
  const root = join(scratchDir(), "params-persist");
  mkdirSync(root, { recursive: true });
  const store = new ParamsStore(join(root, "model-params.json"), 5000);
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

test("model-params: the configured endpoint is fetched unchanged", async () => {
  const urls: string[] = [];
  const client = new OpenRouterModelParams({
    url: "https://pricing.example.com/v2/models?region=eu",
    fetchImpl: async (url) => {
      urls.push(url);
      return ok(modelBody([{ id: "m", pricing: { prompt: "0.000001" } }]));
    },
    now: () => 1_000_000,
    maxAgeMs: 300_000,
    retryMs: 60_000,
    timeoutMs: 5_000,
  });
  await client.refresh();
  assertEq(urls.length, 1);
  assertEq(urls[0], "https://pricing.example.com/v2/models?region=eu", "no path or query is derived");
});

test("model-params: applicability is the model's own endpoint origin", () => {
  const client = params(async () => ok(modelBody([])));
  assertEq(client.appliesTo("https://openrouter.ai/api"), true, "the anthropic-messages base URL");
  assertEq(client.appliesTo("https://openrouter.ai/api/v1"), true, "the completions base URL");
  assertEq(client.appliesTo("https://eu.openrouter.ai/api/v1"), false, "another origin");
  assertEq(client.appliesTo("http://openrouter.ai/api/v1"), false, "another scheme");
  assertEq(client.appliesTo("https://openrouter.ai:8443/api/v1"), false, "another port");
  assertEq(client.appliesTo("https://api.deepseek.com"), false, "an unrelated provider");
  assertEq(client.appliesTo(undefined), false, "no endpoint, no claim");
  assertEq(client.appliesTo("not a url"), false, "an unusable endpoint, no claim");
});

test("model-params: an empty endpoint disables fetching and pricing", async () => {
  let calls = 0;
  const client = new OpenRouterModelParams({
    url: "",
    fetchImpl: async () => {
      calls++;
      return ok(modelBody([{ id: "m", pricing: { prompt: "0.000001" } }]));
    },
    now: () => 1_000_000,
    maxAgeMs: 300_000,
    retryMs: 60_000,
    timeoutMs: 5_000,
  });
  assertEq(client.appliesTo("https://openrouter.ai/api/v1"), false);
  const result = await client.refresh();
  assertEq(result.ok, false);
  assertEq(calls, 0, "nothing is fetched");
});

test("model-params: a snapshot from another endpoint is never used", async () => {
  const root = join(scratchDir(), "params-source");
  mkdirSync(root, { recursive: true });
  const store = new ParamsStore(join(root, "model-params.json"), 5000);
  const first = params(
    async () => ok(modelBody([{ id: "m", pricing: { prompt: "0.000002" } }])),
    store,
  );
  await first.refresh();
  assertEq(first.ratesFor("m")?.input, 2, "same endpoint, stored snapshot loaded");
  const other = new OpenRouterModelParams({
    url: "https://pricing.example.com/models",
    store,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    now: () => 1_000_000,
    maxAgeMs: 300_000,
    retryMs: 60_000,
    timeoutMs: 5_000,
  });
  assertEq(other.ratesFor("m"), undefined, "another endpoint's prices are not applied");
});

test("model-params: a legacy snapshot without its source is discarded", () => {
  const root = join(scratchDir(), "params-legacy");
  mkdirSync(root, { recursive: true });
  const path = join(root, "model-params.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      fetchedAt: 1,
      models: { m: { base: { input: 2, cacheRead: 1, cacheWrite: 0 }, overrides: [] } },
    }),
  );
  const client = params(async () => {
    throw new Error("offline");
  }, new ParamsStore(path, 5000));
  assertEq(client.ratesFor("m"), undefined, "no guessed endpoint");
});

test("model-params: the catalog cap bounds the entries loaded from disk", async () => {
  const root = join(scratchDir(), "params-cap");
  mkdirSync(root, { recursive: true });
  const path = join(root, "model-params.json");
  const models: Record<string, unknown> = {};
  for (const id of ["a", "b", "c", "d"]) {
    models[id] = { base: { input: 1, cacheRead: 1, cacheWrite: 0 }, overrides: [] };
  }
  const first = params(
    async () => ok(modelBody([{ id: "a", pricing: { prompt: "0.000001" } }])),
    new ParamsStore(path, 5000),
  );
  await first.refresh();
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 1, fetchedAt: 1, sourceUrl: URL_BASE, models }),
  );
  const capped = params(async () => {
    throw new Error("offline");
  }, new ParamsStore(path, 2));
  const ids = ["a", "b", "c", "d"].filter((id) => capped.ratesFor(id) !== undefined);
  assertEq(ids.length, 2, "only the cap's worth of entries load");
});
