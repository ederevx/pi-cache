/**
 * pi-cache — calibration statistics.
 *
 * One responsibility: turn paired pass/fail counts into the intervals and
 * classifications the protocol prescribes. Intervals are exact binomial
 * (Clopper-Pearson) computed by bisection on the regularized incomplete
 * beta; the difference interval is the conservative sum of the two
 * components, so no normal approximation is assumed anywhere.
 */

import type { CalibrationPoint } from "./protocol.ts";
import { ACCEPTABLE_QUALITY_LOSS, FAMILY_ALPHA, MATERIAL_FULL_LOSS } from "./protocol.ts";

/** Lanczos log-gamma; enough accuracy for interval endpoints. */
export function logGamma(x: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let series = 0.99999999999980993;
  coefficients.forEach((coefficient, index) => {
    series += coefficient / (shifted + index + 1);
  });
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Continued fraction for the incomplete beta function. */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-12;
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Bisect I_x(a, b) = target for x. */
export function betaQuantile(target: number, a: number, b: number): number {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 200; step += 1) {
    const mid = (low + high) / 2;
    const value = incompleteBeta(a, b, mid);
    if (Math.abs(value - target) < 1e-12) return mid;
    if (value < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Exact (Clopper-Pearson) interval for k successes out of n. */
export function clopperPearson(k: number, n: number, alpha: number): [number, number] {
  if (n <= 0) return [0, 1];
  const low = k === 0 ? 0 : betaQuantile(alpha / 2, k, n - k + 1);
  const high = k === n ? 1 : betaQuantile(1 - alpha / 2, k + 1, n - k);
  return [low, high];
}

/** Paired counts for one contrast: `wins` are X-only successes, `losses` Y-only. */
export interface PairedCounts {
  wins: number;
  losses: number;
  pairs: number;
}

/** Conservative interval for p(wins) - p(losses), from the two exact intervals. */
export function pairedDifferenceInterval(
  counts: PairedCounts,
  alpha: number,
): [number, number] {
  const half = alpha / 2;
  const wins = clopperPearson(counts.wins, counts.pairs, half);
  const losses = clopperPearson(counts.losses, counts.pairs, half);
  return [wins[0] - losses[1], wins[1] - losses[0]];
}

/** The contrast budget: five DIGEST-vs-FULL lengths plus four FULL-baseline lengths. */
export function contrastsPerLook(lengths: number): number {
  return lengths + Math.max(0, lengths - 1);
}

/** Per-contrast alpha after the familywise split across looks. */
export function perContrastAlpha(lengths: number, looks: number): number {
  return FAMILY_ALPHA / (contrastsPerLook(lengths) * Math.max(1, looks));
}

/** Classify one length against the protocol's thresholds. */
export function classify(
  digestMinusFull: [number, number],
  fullLoss: [number, number] | null,
): CalibrationPoint["classification"] {
  if (digestMinusFull[1] < -ACCEPTABLE_QUALITY_LOSS) return "harmful";
  // Material full-history loss with a digest leg that is not worse than the
  // tolerated margin is exactly the case the trigger exists for; requiring the
  // digest to be *better* would answer "safe" for the shape that matters.
  if (
    fullLoss &&
    fullLoss[0] > MATERIAL_FULL_LOSS &&
    digestMinusFull[0] >= -ACCEPTABLE_QUALITY_LOSS
  ) {
    return "trigger";
  }
  if (digestMinusFull[0] > -ACCEPTABLE_QUALITY_LOSS) return "safe";
  return "inconclusive";
}
