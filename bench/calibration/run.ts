/**
 * pi-cache — calibration runner.
 *
 * One responsibility: execute the frozen protocol - every fixture, at
 * every length, in both legs - grade each continuation, and write the
 * profile. Order is shuffled from a fixed seed and each cell gets an
 * identical request budget, so a run is reproducible in shape even
 * though the model's answers are not. `PI_CALIBRATION_DRY=1` swaps in a
 * deterministic stub, which exercises the harness without a network.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HistoryBuilder, estimateMessagesTokens } from "./history.ts";
import { LegBuilder } from "./legs.ts";
import {
  HttpChatClient,
  StubClient,
  readApiKeyFromEnv,
  toChatMessages,
  type ContinuationClient,
} from "./client.ts";
import { FixtureRepo, extractAnswer } from "./repo.ts";
import { FIXTURES, fixtureById } from "./fixtures.ts";
import {
  REQUEST_LIMITS,
  SWEEP_LENGTHS,
  type Fixture,
  type Leg,
  type Observation,
} from "./protocol.ts";
import { buildProfile, formatProfile } from "./report.ts";

/** A deterministic shuffle so execution order is reproducible. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swap = state % (index + 1);
    const held = out[index] as T;
    out[index] = out[swap] as T;
    out[swap] = held;
  }
  return out;
}

/** Everything a run needs, read from the environment once. */
interface RunConfig {
  model: string;
  baseUrl: string;
  lengths: number[];
  fixtures: Fixture[];
  repeats: number;
  dry: boolean;
  outDir: string;
  seed: number;
}

/** Reads the run configuration; no credential has a default. */
function readConfig(): RunConfig {
  const env = process.env;
  const dry = env.PI_CALIBRATION_DRY === "1";
  const lengths = (env.PI_CALIBRATION_LENGTHS ?? SWEEP_LENGTHS.join(","))
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const fixtures = (env.PI_CALIBRATION_FIXTURES ?? FIXTURES.map((fixture) => fixture.id).join(","))
    .split(",")
    .map((id) => fixtureById(id.trim()));
  const repeats = Number.parseInt(env.PI_CALIBRATION_REPEATS ?? "1", 10);
  return {
    model: env.PI_CALIBRATION_MODEL ?? (dry ? "stub" : ""),
    baseUrl: env.PI_CALIBRATION_BASE_URL ?? "",
    lengths,
    fixtures,
    repeats: Number.isFinite(repeats) && repeats > 0 ? repeats : 1,
    dry,
    outDir:
      env.PI_CALIBRATION_OUT ??
      join(resolve(dirname(fileURLToPath(import.meta.url))), "results"),
    seed: Number.parseInt(env.PI_CALIBRATION_SEED ?? "20261030", 10),
  };
}

/** Runs one cell: build the history, send the leg, grade the answer. */
class CellRunner {
  private readonly client: ContinuationClient;
  private readonly builder = new HistoryBuilder();
  private readonly legs = new LegBuilder();

  constructor(client: ContinuationClient) {
    this.client = client;
  }

  async run(fixture: Fixture, targetTokens: number, leg: Leg, repeat: number): Promise<Observation> {
    const history = this.builder.build(fixture, targetTokens);
    const messages = this.legs.leg(history, leg);
    const chat = toChatMessages(messages);
    const started = Date.now();
    const repo = await FixtureRepo.materialise(
      fixture,
      `${fixture.id}-${targetTokens}-${leg}-${repeat}`,
    );
    const base: Observation = {
      model: "",
      fixtureId: fixture.id,
      fixtureKind: fixture.kind,
      targetTokens,
      estimatedPromptTokens: estimateMessagesTokens(messages),
      leg,
      repeat,
      success: false,
      transportFailure: false,
      wallMs: 0,
      usage: { promptTokens: null, cachedTokens: null, completionTokens: null },
      promptTokens: estimateMessagesTokens(messages),
      answer: "",
      gradeDetail: "",
      truncated: false,
      unusable: false,
    };
    try {
      let result;
      try {
        result = await this.client.complete({
          messages: chat,
          maxOutputTokens: REQUEST_LIMITS.maxOutputTokens,
          temperature: REQUEST_LIMITS.temperature,
        });
      } catch (error) {
        // Only the request has a transport that can fail. A scratch-repo or
        // grading failure is a harness defect and must not pass as one.
        return {
          ...base,
          transportFailure: true,
          wallMs: Date.now() - started,
          gradeDetail: error instanceof Error ? error.message.slice(0, 200) : String(error),
        };
      }
      if (result.text.trim() === "") {
        return {
          ...base,
          model: result.model,
          transportFailure: false,
          unusable: true,
          wallMs: Date.now() - started,
          usage: result.usage,
          promptTokens: result.usage.promptTokens ?? base.estimatedPromptTokens,
          gradeDetail: `empty completion (${result.finishReason ?? "no finish reason"})`,
          truncated: result.finishReason === "length",
        };
      }
      const refusal = await repo.apply(extractAnswer(result.text));
      const grade = refusal ?? (await repo.grade());
      return {
        ...base,
        model: result.model,
        success: grade.success,
        wallMs: Date.now() - started,
        usage: result.usage,
        promptTokens: result.usage.promptTokens ?? base.estimatedPromptTokens,
        answer: result.text.slice(0, 600),
        gradeDetail: grade.detail,
        truncated: result.finishReason === "length",
      };
    } finally {
      await rm(repo.path, { recursive: true, force: true });
    }
  }
}

/** The whole sweep. */
class CalibrationRun {
  private readonly config: RunConfig;
  private readonly cells: CellRunner;

  constructor(config: RunConfig, client: ContinuationClient) {
    this.config = config;
    this.cells = new CellRunner(client);
  }

  async execute(): Promise<void> {
    const observations: Observation[] = [];
    for (const repeat of Array.from({ length: this.config.repeats }, (_, index) => index)) {
      const schedule = shuffled(
        this.config.fixtures.flatMap((fixture) =>
          this.config.lengths.flatMap((length) =>
            (["full", "digest"] as const).map((leg) => ({ fixture, length, leg })),
          ),
        ),
        this.config.seed + repeat,
      );
      for (const cell of schedule) {
        const observation = await this.cells.run(cell.fixture, cell.length, cell.leg, repeat);
        observations.push(observation);
        const status = observation.transportFailure
          ? "transport"
          : observation.success
            ? "pass"
            : "fail";
        process.stderr.write(
          `${cell.fixture.id} ${cell.length} ${cell.leg} r${repeat} ${status} ${observation.promptTokens}tok ${Math.round(observation.wallMs / 1000)}s\n`,
        );
      }
    }
    const profile = buildProfile(observations, {
      model: this.config.model,
      providerBase: this.config.baseUrl,
      plannedTasks: this.config.fixtures.length * this.config.repeats,
      seed: this.config.seed,
      repeats: this.config.repeats,
      note: this.config.dry
        ? "dry run: deterministic stub answers, harness only, no model measurement"
        : "live run: provider-reported usage, exact paired intervals, no extrapolation beyond tested lengths",
    });
    await mkdir(this.config.outDir, { recursive: true });
    const stamp = profile.createdAt.replace(/[:.]/g, "-");
    const path = join(this.config.outDir, `${profile.model.replace(/[^a-z0-9.-]+/gi, "_")}-${stamp}.json`);
    await writeFile(path, `${JSON.stringify({ profile, observations }, null, 2)}\n`, "utf8");
    process.stdout.write(`${formatProfile(profile)}\n\nresults: ${path}\n`);
  }
}

/** Entry point. */
async function main(): Promise<void> {
  const config = readConfig();
  if (!config.dry && (config.model === "" || config.baseUrl === "")) {
    throw new Error(
      "set PI_CALIBRATION_MODEL, PI_CALIBRATION_BASE_URL and PI_CALIBRATION_API_KEY, or PI_CALIBRATION_DRY=1",
    );
  }
  const client: ContinuationClient = config.dry
    ? new StubClient((request) => {
        const text = request.messages.map((message) => message.content).join("\n");
        const fixture = FIXTURES.find((candidate) => text.includes(candidate.file));
        return ["```js", fixture?.fixed ?? "// no fixture", "```"].join("\n");
      })
    : new HttpChatClient({
        baseUrl: config.baseUrl,
        apiKey: readApiKeyFromEnv(),
        model: config.model,
        timeoutMs: REQUEST_LIMITS.timeoutMs,
        retries: REQUEST_LIMITS.retries,
      });
  await new CalibrationRun(config, client).execute();
}

await main();
