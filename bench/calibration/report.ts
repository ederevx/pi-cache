/**
 * pi-cache — calibration report.
 *
 * One responsibility: fold graded observations into the per-length profile
 * the protocol asks for - paired success rates, conservative intervals,
 * one classification per length, and the first tested length whose
 * evidence supports a quality-driven trigger. Two contrasts are kept
 * apart: DIGEST against FULL at the same length, and FULL at that length
 * against FULL at the shortest tested length.
 */

import { createHash } from "node:crypto";
import { FIXTURES } from "./fixtures.ts";
import {
  ACCEPTABLE_QUALITY_LOSS,
  CHARS_PER_TOKEN,
  IMPLEMENTATION_VERSION,
  MATERIAL_FULL_LOSS,
  REQUEST_LIMITS,
  SWEEP_LENGTHS,
  type CalibrationPoint,
  type CalibrationProfile,
  type Leg,
  type Observation,
} from "./protocol.ts";
import { classify, pairedDifferenceInterval, perContrastAlpha, type PairedCounts } from "./stats.ts";

/** A pairing key: one fixture, one repeat. */
function pairKey(observation: Observation): string {
  return `${observation.fixtureId}#${observation.repeat}`;
}

/** Index graded observations by key, keeping only the requested leg and length. */
function index(
  observations: readonly Observation[],
  predicate: (observation: Observation) => boolean,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const observation of observations) {
    if (observation.transportFailure || observation.unusable || !predicate(observation)) continue;
    out.set(pairKey(observation), observation.success);
  }
  return out;
}

/** Discriminant counts over keys present on both sides. */
function pairwise(left: Map<string, boolean>, right: Map<string, boolean>): PairedCounts {
  let wins = 0;
  let losses = 0;
  let pairs = 0;
  for (const [key, leftValue] of left) {
    const rightValue = right.get(key);
    if (rightValue === undefined) continue;
    pairs += 1;
    if (rightValue && !leftValue) wins += 1;
    if (leftValue && !rightValue) losses += 1;
  }
  return { wins, losses, pairs };
}

/**
 * The paired point estimate behind an interval: wins minus losses over the
 * pairs, so the printed number, its pair count and its interval all describe
 * the same cells. A difference of marginal rates would use two denominators.
 */
function pairedEstimate(counts: PairedCounts): number {
  return counts.pairs === 0 ? 0 : (counts.wins - counts.losses) / counts.pairs;
}

/** Success rate for a leg at a length, over its own usable cells. */
function rate(
  observations: readonly Observation[],
  leg: Leg,
  length: number,
): number {
  const cells = observations.filter(
    (observation) =>
      !observation.transportFailure &&
      !observation.unusable &&
      observation.leg === leg &&
      observation.targetTokens === length,
  );
  if (cells.length === 0) return 0;
  return cells.filter((observation) => observation.success).length / cells.length;
}

/** The lengths a run actually covered, ascending. */
export function observedLengths(observations: readonly Observation[]): number[] {
  const lengths = new Set<number>();
  for (const observation of observations) lengths.add(observation.targetTokens);
  return [...lengths].sort((left, right) => left - right);
}

/** The profile hash input that makes a stored result reproducible. */
export function benchmarkHash(seed: number | null, lengths: readonly number[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ fixtures: FIXTURES, lengths, seed }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The protocol fingerprint: every number that decides what a stored profile
 * means. A profile that cannot be tied to its estimator, request limits, seed
 * and margins is not evidence of anything, so they are all in the hash, over
 * the lengths the run covered rather than the ones this build defaults to.
 */
export function protocolHash(
  alpha: number,
  seed: number | null,
  repeats: number,
  lengths: readonly number[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementation: IMPLEMENTATION_VERSION,
        lengths,
        alpha,
        acceptableQualityLoss: ACCEPTABLE_QUALITY_LOSS,
        materialFullLoss: MATERIAL_FULL_LOSS,
        charsPerToken: CHARS_PER_TOKEN,
        requestLimits: REQUEST_LIMITS,
        seed,
        repeats,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Build the stored profile from raw observations. */
export function buildProfile(
  observations: readonly Observation[],
  options: {
    model: string;
    providerBase: string;
    plannedTasks: number;
    note: string;
    seed: number | null;
    repeats: number;
  },
): CalibrationProfile {
  const alpha = perContrastAlpha(observedLengths(observations).length, 1);
  const lengths = observedLengths(observations);
  const baselineLength = lengths[0] ?? SWEEP_LENGTHS[0] ?? 0;
  const points: CalibrationPoint[] = [];
  for (const length of lengths) {
    const deltaPairs = pairwise(
      index(
        observations,
        (observation) => observation.leg === "full" && observation.targetTokens === length,
      ),
      index(
        observations,
        (observation) => observation.leg === "digest" && observation.targetTokens === length,
      ),
    );
    const delta = pairedDifferenceInterval(deltaPairs, alpha);
    const fullLossPairs =
      length === baselineLength
        ? null
        : pairwise(
            // Baseline first would answer the reverse: degradation is
            // baseline minus this length, so the shorter leg is the left side.
            index(
              observations,
              (observation) =>
                observation.leg === "full" && observation.targetTokens === length,
            ),
            index(
              observations,
              (observation) =>
                observation.leg === "full" && observation.targetTokens === baselineLength,
            ),
          );
    const fullLoss = fullLossPairs === null ? null : pairedDifferenceInterval(fullLossPairs, alpha);
    const fullSuccessRate = rate(observations, "full", length);
    points.push({
      targetTokens: length,
      tasks: deltaPairs.pairs,
      fullSuccessRate,
      digestSuccessRate: rate(observations, "digest", length),
      digestMinusFull: pairedEstimate(deltaPairs),
      digestMinusFullCi: delta,
      fullLossFromBaseline: fullLossPairs === null ? null : pairedEstimate(fullLossPairs),
      fullLossFromBaselineCi: fullLoss,
      classification: classify(delta, fullLoss),
    });
  }
  const firstTrigger = points.find((point) => point.classification === "trigger");
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    model: options.model,
    providerBase: options.providerBase,
    benchmarkHash: benchmarkHash(options.seed, lengths),
    protocolHash: protocolHash(alpha, options.seed, options.repeats, lengths),
    acceptableQualityLoss: ACCEPTABLE_QUALITY_LOSS,
    materialFullHistoryLoss: MATERIAL_FULL_LOSS,
    plannedTasks: options.plannedTasks,
    seed: options.seed,
    repeats: options.repeats,
    lengths,
    charsPerToken: CHARS_PER_TOKEN,
    requestLimits: { ...REQUEST_LIMITS },
    implementation: IMPLEMENTATION_VERSION,
    observations: observations.length,
    transportFailureRate:
      observations.length === 0
        ? 0
        : observations.filter((observation) => observation.transportFailure).length /
          observations.length,
    truncatedRate:
      observations.length === 0
        ? 0
        : observations.filter((observation) => observation.truncated).length / observations.length,
    unusableRate:
      observations.length === 0
        ? 0
        : observations.filter((observation) => observation.unusable).length / observations.length,
    points,
    firstSupportedTriggerTokens: firstTrigger?.targetTokens ?? null,
    note: options.note,
  };
}

/** The table a human reads when a run finishes. */
export function formatProfile(profile: CalibrationProfile): string {
  const header = ["length", "pairs", "full", "digest", "delta", "delta ci", "loss ci", "class"];
  const rows = profile.points.map((point) => [
    String(point.targetTokens),
    String(point.tasks),
    point.fullSuccessRate.toFixed(3),
    point.digestSuccessRate.toFixed(3),
    point.digestMinusFull.toFixed(3),
    `[${point.digestMinusFullCi[0].toFixed(3)}, ${point.digestMinusFullCi[1].toFixed(3)}]`,
    point.fullLossFromBaselineCi === null
      ? "-"
      : `[${point.fullLossFromBaselineCi[0].toFixed(3)}, ${point.fullLossFromBaselineCi[1].toFixed(3)}]`,
    point.classification,
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ");
  return [
    line(header),
    ...rows.map(line),
    "",
    `model ${profile.model} | observations ${profile.observations} | unusable ${(
      profile.unusableRate * 100
    ).toFixed(1)}% | transport failures ${(profile.transportFailureRate * 100).toFixed(
      1,
    )}% | truncated ${(profile.truncatedRate * 100).toFixed(1)}% | first supported trigger ${
      profile.firstSupportedTriggerTokens ?? "none"
    }`,
  ].join("\n");
}
