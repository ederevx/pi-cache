/**
 * pi-cache — calibration harness tests.
 *
 * The sweep's own plumbing must be right before any number it produces
 * means anything: histories nest, the digest leg replaces exactly the
 * dropped span, grading refuses a weakened test, and the statistics
 * return the documented intervals. Every test here runs offline; the
 * model is a stub.
 */

import { test, assert, assertEq, scratchDir } from "./harness.ts";
import { join } from "node:path";
import { HistoryBuilder, estimateMessagesTokens } from "../bench/calibration/history.ts";
import { LegBuilder, DIGEST_PREAMBLE } from "../bench/calibration/legs.ts";
import { FIXTURES, fixtureById } from "../bench/calibration/fixtures.ts";
import { FixtureRepo, extractAnswer } from "../bench/calibration/repo.ts";
import { StubClient, readApiKeyFromEnv, toChatMessages } from "../bench/calibration/client.ts";
import { buildProfile, formatProfile, protocolHash } from "../bench/calibration/report.ts";
import {
  clopperPearson,
  pairedDifferenceInterval,
  classify,
  perContrastAlpha,
  logGamma,
  incompleteBeta,
} from "../bench/calibration/stats.ts";
import {
  CHARS_PER_TOKEN,
  IMPLEMENTATION_VERSION,
  REQUEST_LIMITS,
  SWEEP_LENGTHS,
  type Observation,
} from "../bench/calibration/protocol.ts";

const builder = new HistoryBuilder();
const legs = new LegBuilder();
const tailFixture = fixtureById("parse-price");
const historyFixture = fixtureById("chunk-items");

test("calibration: histories nest at every length", () => {
  const short = builder.build(tailFixture, 4000);
  const long = builder.build(tailFixture, 9000);
  assert(short.dropped.length < long.dropped.length, "longer target needs more blocks");
  for (let index = 0; index < short.dropped.length; index += 1) {
    const left = JSON.stringify(short.dropped[index]);
    const right = JSON.stringify(long.dropped[index]);
    assertEq(right, left);
  }
  assertEq(JSON.stringify(short.tail), JSON.stringify(long.tail));
});

test("calibration: the digest leg replaces exactly the dropped span", () => {
  const history = builder.build(tailFixture, 6000);
  const full = legs.leg(history, "full");
  const digest = legs.leg(history, "digest");
  assertEq(JSON.stringify(full.slice(-history.tail.length)), JSON.stringify(history.tail));
  assertEq(JSON.stringify(digest.slice(1)), JSON.stringify(history.tail));
  const preamble = digest[0]?.content[0]?.text ?? "";
  assert(preamble.startsWith(DIGEST_PREAMBLE), "digest leg announces the compaction");
  assert(preamble.includes("<pi-cache-digest>"), "digest leg carries the digest region");
  assert(preamble.includes("src/legacy/module-"), "digest keeps the file list");
});

test("calibration: a history fixture's source is only in the dropped span", () => {
  const history = builder.build(historyFixture, 6000);
  const fullText = toChatMessages(history.full)
    .map((message) => message.content)
    .join("\n");
  const digestText = toChatMessages(legs.leg(history, "digest"))
    .map((message) => message.content)
    .join("\n");
  assert(fullText.includes(historyFixture.broken), "full leg carries the source");
  assert(!digestText.includes(historyFixture.broken), "digest drops the source body");
  assert(digestText.includes(historyFixture.file), "digest still names the file");
});

test("calibration: a target below the skeleton is refused", () => {
  let refused = false;
  try {
    builder.build(tailFixture, 10);
  } catch {
    refused = true;
  }
  assert(refused, "a skeleton-only length cannot be built");
});

test("calibration: grading fails before the fix and passes after it", async () => {
  const repo = await FixtureRepo.materialise(tailFixture, "grade", join(scratchDir(), "calibration"));
  const before = await repo.grade();
  assert(!before.success, "the broken source must fail its own test");
  const applied = await repo.apply(tailFixture.fixed);
  assertEq(applied, null);
  const after = await repo.grade();
  assert(after.success, `fixed source must pass: ${after.detail}`);
});

test("calibration: grading refuses a weakened test file", async () => {
  const { writeFileSync } = await import("node:fs");
  const repo = await FixtureRepo.materialise(tailFixture, "tamper", join(scratchDir(), "calibration"));
  writeFileSync(join(repo.path, "test", `${tailFixture.id}.test.js`), "// weakened\n", "utf8");
  await repo.apply(tailFixture.fixed);
  const grade = await repo.grade();
  assert(!grade.success, "a modified test file voids the grade");
  assert(grade.detail.includes("modified"), grade.detail);
});

test("calibration: grading refuses a test weakened while the run executes", async () => {
  const id = "tamper-late";
  const fixture = {
    ...tailFixture,
    id,
    file: `src/${id}.js`,
    broken: "export const ok = false;\n",
    fixed: [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(new URL("../test/${id}.test.js", import.meta.url), "// weakened\\n");`,
      "export const ok = true;",
    ].join("\n"),
    test: [
      'import { test } from "node:test";',
      `import { ok } from "../src/${id}.js";`,
      'test("ok", () => {});',
    ].join("\n"),
  };
  const repo = await FixtureRepo.materialise(fixture, "tamper-late", join(scratchDir(), "calibration"));
  assertEq(await repo.apply(fixture.fixed), null);
  const grade = await repo.grade();
  assert(!grade.success, "a test weakened during the run voids the grade");
  assert(grade.detail.includes("during the run"), grade.detail);
});

test("calibration: answers are taken from the last fenced block", () => {
  assertEq(extractAnswer("```js\none()\n```\n```js\ntwo()\n```"), "two()\n");
  assertEq(extractAnswer("no fence here"), null);
  assertEq(extractAnswer("```js\nexport const a = 1;"), "export const a = 1;");
  assertEq(extractAnswer("```\nplain\n```"), "plain\n");
});

test("calibration: a stub continuation reaches the grader", async () => {
  const stub = new StubClient(() => `\`\`\`js\n${tailFixture.fixed}\`\`\``);
  const result = await stub.complete({ messages: [], maxOutputTokens: 10, temperature: 0 });
  assertEq(extractAnswer(result.text), tailFixture.fixed);
  assertEq(stub.seen.length, 1);
});

test("calibration: statistics match their definitions", () => {
  const zero = clopperPearson(0, 10, 0.05);
  assertEq(zero[0], 0);
  assert(Math.abs(zero[1] - 0.3085) < 0.002, `upper ${zero[1]}`);
  const all = clopperPearson(10, 10, 0.05);
  assertEq(all[1], 1);
  assert(Math.abs(all[0] - 0.6915) < 0.002, `lower ${all[0]}`);
  const symmetric = pairedDifferenceInterval({ wins: 3, losses: 1, pairs: 20 }, 0.01);
  assert(symmetric[1] > 0.1, "three wins one loss is a positive contrast");
  assertEq(classify([-0.01, 0.05], null), "safe");
  assertEq(classify([-0.4, -0.2], null), "harmful");
  assertEq(classify([0.02, 0.3], [0.1, 0.4]), "trigger");
  assertEq(classify([0.02, 0.3], [0.0, 0.04]), "safe");
  // Material full loss with the digest inside the non-inferiority margin is the
  // case the trigger exists for: a model degrading with length while compaction
  // adds nothing must not read as "safe".
  assertEq(classify([-0.02, 0.02], [0.1, 0.4]), "trigger");
  assertEq(classify([-0.049, 0.02], [0.1, 0.4]), "trigger");
  assertEq(classify([-0.05, 0.02], [0.1, 0.4]), "trigger");
  assert(Math.abs(incompleteBeta(1, 1, 0.5) - 0.5) < 1e-9, "I_0.5(1,1)");
  assert(Math.abs(logGamma(5) - Math.log(24)) < 1e-9, "logGamma(5)");
  assert(perContrastAlpha(5, 3) < 0.05 / 9, "family split is conservative");
});

/** Synthetic observations: FULL always passes, DIGEST passes only on tail fixtures. */
function synthetic(digestOnHistory: boolean, repeats = 10): Observation[] {
  const out: Observation[] = [];
  for (const length of SWEEP_LENGTHS) {
    for (const fixture of FIXTURES) {
      for (const repeat of Array.from({ length: repeats }, (_, index) => index)) {
        for (const leg of ["full", "digest"] as const) {
          const success = leg === "full" || fixture.kind === "tail" || digestOnHistory;
          out.push({
            model: "synthetic",
            fixtureId: fixture.id,
            fixtureKind: fixture.kind,
            targetTokens: length,
            estimatedPromptTokens: length,
            leg,
            repeat,
            success,
            transportFailure: false,
            wallMs: 1,
            usage: { promptTokens: length, cachedTokens: null, completionTokens: 10 },
            promptTokens: length,
            answer: "```js\nexport const ok = true;\n```",
            gradeDetail: "",
            truncated: false,
            unusable: false,
          });
        }
      }
    }
  }
  return out;
}

test("calibration: an empty completion measures the budget, not the task", () => {
  const observations = synthetic(true, 4);
  for (const observation of observations) {
    if (observation.leg === "full" && observation.targetTokens === SWEEP_LENGTHS[0]) {
      // Repeat 0 comes back empty (nothing to grade), repeat 1 answers and
      // fails, repeats 2+ pass: only the empty cells leave the rates.
      observation.unusable = observation.repeat === 0;
      observation.success = observation.repeat !== 0 && observation.repeat !== 1;
    }
  }
  const profile = buildProfile(observations, {
    model: "synthetic",
    providerBase: "",
    plannedTasks: FIXTURES.length,
    note: "synthetic",
    seed: 1,
    repeats: 4,
  });
  const point = profile.points[0];
  assertEq(point?.tasks, FIXTURES.length * 3, "the unusable pair is dropped");
  assert(Math.abs((point?.fullSuccessRate ?? 0) - 2 / 3) < 1e-9, `rate ${point?.fullSuccessRate}`);
  assert(Math.abs(profile.unusableRate - FIXTURES.length / observations.length) < 1e-9, "share");
});

test("calibration: the fingerprint names the configuration, not just the lengths", () => {
  const base = protocolHash(0.05 / 9, 1, 2, SWEEP_LENGTHS);
  assertEq(base.length, 16);
  assert(base !== protocolHash(0.05 / 9, 2, 2, SWEEP_LENGTHS), "seed is part of the fingerprint");
  assert(base !== protocolHash(0.05 / 9, 1, 3, SWEEP_LENGTHS), "repeat count is part of the fingerprint");
  assert(base !== protocolHash(0.05 / 5, 1, 2, SWEEP_LENGTHS), "alpha is part of the fingerprint");
  assert(
    base !== protocolHash(0.05 / 9, 1, 2, SWEEP_LENGTHS.slice(0, 3)),
    "the lengths the run covered are part of the fingerprint",
  );
  assert(base !== protocolHash(0.05 / 9, null, 2, SWEEP_LENGTHS), "an unrecorded seed differs");
});

test("calibration: a profile stores the estimator and budget it was read under", () => {
  const profile = buildProfile(synthetic(true, 2), {
    model: "synthetic",
    providerBase: "",
    plannedTasks: FIXTURES.length,
    note: "synthetic",
    seed: null,
    repeats: 2,
  });
  assertEq(profile.seed, null, "no order seed is invented for the record");
  assertEq(JSON.stringify(profile.lengths), JSON.stringify(SWEEP_LENGTHS));
  assertEq(profile.charsPerToken, CHARS_PER_TOKEN);
  assertEq(profile.requestLimits.maxOutputTokens, REQUEST_LIMITS.maxOutputTokens);
  assertEq(profile.implementation, IMPLEMENTATION_VERSION);
  assert(formatProfile(profile).includes("unusable"), "the printed report shows the unusable share");
});

/** Synthetic observations where each length carries its own success rates. */
function syntheticRates(
  fullPass: (length: number) => boolean,
  digestPass: (length: number) => boolean,
  repeats = 10,
): Observation[] {
  return synthetic(true, repeats).map((observation) => ({
    ...observation,
    success:
      observation.leg === "full"
        ? fullPass(observation.targetTokens)
        : digestPass(observation.targetTokens),
  }));
}

test("calibration: full-history loss runs from the baseline to the longer length", () => {
  const longer = SWEEP_LENGTHS[SWEEP_LENGTHS.length - 1] ?? 0;
  const degrading = syntheticRates(
    (length) => length !== longer,
    () => true,
  );
  const profile = buildProfile(degrading, {
    model: "synthetic",
    providerBase: "",
    plannedTasks: FIXTURES.length,
    note: "synthetic",
    seed: 1,
    repeats: 10,
  });
  const last = profile.points[profile.points.length - 1];
  assert(
    (last?.fullLossFromBaseline ?? 0) > 0,
    `degradation is baseline minus this length, got ${last?.fullLossFromBaseline}`,
  );
  assertEq(last?.classification, "trigger");
  assertEq(profile.firstSupportedTriggerTokens, longer);
});

test("calibration: a full leg that improves with length is not degradation", () => {
  const baseline = SWEEP_LENGTHS[0] ?? 0;
  const improving = syntheticRates(
    (length) => length !== baseline,
    (length) => length !== baseline,
  );
  const profile = buildProfile(improving, {
    model: "synthetic",
    providerBase: "",
    plannedTasks: FIXTURES.length,
    note: "synthetic",
    seed: 1,
    repeats: 10,
  });
  assert(
    (profile.points[1]?.fullLossFromBaseline ?? 0) < 0,
    `improvement must read negative, got ${profile.points[1]?.fullLossFromBaseline}`,
  );
  assertEq(profile.firstSupportedTriggerTokens, null, "improvement is never a trigger");
});

test("calibration: the profile reads paired cells and never invents an onset", () => {
  const lossy = buildProfile(synthetic(false), {
    model: "synthetic",
    providerBase: "",
    plannedTasks: FIXTURES.length,
    note: "synthetic",
    seed: 1,
    repeats: 10,
  });
  assertEq(lossy.observations, SWEEP_LENGTHS.length * FIXTURES.length * 2 * 10);
  assertEq(lossy.points[0]?.classification, "harmful");
  assertEq(lossy.firstSupportedTriggerTokens, null);
  assertEq(lossy.points[0]?.fullSuccessRate, 1);
  assertEq(lossy.points[0]?.tasks, FIXTURES.length * 10);
  assert(lossy.points[0]?.digestMinusFullCi[1] < 0, "digest loses on history fixtures");

  const clean = buildProfile(synthetic(true, 100), {
    model: "synthetic",
    providerBase: "",
    plannedTasks: FIXTURES.length,
    note: "synthetic",
    seed: 1,
    repeats: 10,
  });
  assertEq(clean.points[0]?.classification, "safe");
  assertEq(clean.points[0]?.fullLossFromBaselineCi, null);
  assertEq(clean.transportFailureRate, 0);

  const tooFew = buildProfile(synthetic(true, 10), {
    model: "synthetic",
    providerBase: "",
    plannedTasks: FIXTURES.length,
    note: "synthetic",
    seed: 1,
    repeats: 10,
  });
  assertEq(
    tooFew.points[0]?.classification,
    "inconclusive",
    "forty all-pass pairs cannot certify a five-point noninferiority margin",
  );
});

test("calibration: no default credential is invented", () => {
  assertThrows(
    () => readApiKeyFromEnv({}),
    "an unset key must be refused rather than sent as an empty credential",
  );
  assertThrows(
    () => readApiKeyFromEnv({ PI_CALIBRATION_API_KEY: "   " }),
    "a blank key must be refused too",
  );
  assertEq(
    readApiKeyFromEnv({ PI_CALIBRATION_API_KEY: "k" }),
    "k",
    "a supplied key is returned unchanged",
  );
});

function assertThrows(fn: () => unknown, why: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, why);
}
