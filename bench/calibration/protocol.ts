/**
 * pi-cache — calibration protocol constants and shared shapes.
 *
 * One responsibility: the frozen decisions of the sweep (lengths, margin,
 * error budget, request limits) and the record types that carry an
 * observation from the runner to the report. Changing any value here
 * invalidates a stored profile, so the profile hashes this module.
 */

/** Lengths swept, in estimated prompt tokens. */
export const SWEEP_LENGTHS: readonly number[] = [32000, 64000, 100000, 128000, 200000];

/**
 * The grading and statistics this harness implements. Bumping it is what
 * invalidates a stored profile when the code changes but no protocol constant
 * does, so a fingerprint cannot survive a change of estimator.
 */
export const IMPLEMENTATION_VERSION = 2;

/** Five absolute success points is the tolerated DIGEST loss. */
export const ACCEPTABLE_QUALITY_LOSS = 0.05;

/** Five absolute points is a material FULL loss against the 32k baseline. */
export const MATERIAL_FULL_LOSS = 0.05;

/** Familywise error for the whole sweep. */
export const FAMILY_ALPHA = 0.05;

/**
 * Characters per token for length targeting, measured 2026-10-31 against
 * provider-reported input on the verboo router (32k target: 32 348 estimated,
 * 44 169 reported; 200k target: 200 433 estimated, 273 747 reported).
 */
export const CHARS_PER_TOKEN = 2.9;

/** Which history a continuation is shown. */
export type Leg = "full" | "digest";

/** Every leg runs the same request limits. */
export const REQUEST_LIMITS = {
  maxOutputTokens: 8000,
  timeoutMs: 900000,
  retries: 2,
  temperature: 0,
} as const;

/** A request budget, copied into a profile so the numbers stay checkable. */
export interface RequestLimits {
  maxOutputTokens: number;
  timeoutMs: number;
  retries: number;
  temperature: number;
}

/** A task whose fix can be graded by its own test file. */
export interface Fixture {
  /** Stable id; also seeds the distractor stream. */
  id: string;
  /** `tail`: the target file is in the kept tail. `history`: only in the dropped span. */
  kind: "tail" | "history";
  /** File the model must rewrite, relative to the scratch repo. */
  file: string;
  /** Source that fails its test. */
  broken: string;
  /** Source that passes it. */
  fixed: string;
  /** Test file content, identical for both sources. */
  test: string;
  /** What the user asks for; identical wording in every leg and length. */
  task: string;
  /** The earlier decision that only the history carries, when it matters. */
  decision?: string;
}

/** What a provider reported for one continuation. */
export interface Usage {
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
}

/** One graded continuation. */
export interface Observation {
  model: string;
  fixtureId: string;
  fixtureKind: Fixture["kind"];
  targetTokens: number;
  estimatedPromptTokens: number;
  leg: Leg;
  repeat: number;
  success: boolean;
  transportFailure: boolean;
  wallMs: number;
  usage: Usage;
  /** Provider-reported input when available, else the estimate. */
  promptTokens: number;
  /** Kept for the raw record; truncated in printed reports. */
  answer: string;
  gradeDetail: string;
  /** The provider stopped at the output limit, whatever the grade says. */
  truncated: boolean;
  /**
   * There was nothing to grade - an empty completion, typically an output
   * limit spent on reasoning - so the cell measures the budget, not the task.
   * Rates are computed over usable cells and this share is reported beside
   * them.
   */
  unusable: boolean;
}

/** One length's paired result. */
export interface CalibrationPoint {
  targetTokens: number;
  tasks: number;
  fullSuccessRate: number;
  digestSuccessRate: number;
  digestMinusFull: number;
  digestMinusFullCi: [number, number];
  fullLossFromBaseline: number | null;
  fullLossFromBaselineCi: [number, number] | null;
  classification: "safe" | "harmful" | "trigger" | "inconclusive";
}

/** The stored evidence for one configuration. */
export interface CalibrationProfile {
  schemaVersion: 1;
  createdAt: string;
  model: string;
  providerBase: string;
  benchmarkHash: string;
  protocolHash: string;
  acceptableQualityLoss: number;
  materialFullHistoryLoss: number;
  plannedTasks: number;
  /**
   * Order seed and repeat count, so a profile names the run that made it. The
   * seed is null when the record it was derived from never carried one: an
   * invented order is not provenance.
   */
  seed: number | null;
  repeats: number;
  /** The lengths the run covered, and the estimator that turned text into them. */
  lengths: number[];
  charsPerToken: number;
  /** The request budget every leg shared. */
  requestLimits: RequestLimits;
  /** The grading and statistics version; with the hashes it pins the meaning. */
  implementation: number;
  observations: number;
  transportFailureRate: number;
  /** Share of observations with nothing to grade; excluded from the rates. */
  unusableRate: number;
  /** Share of observations the provider stopped at the output limit. */
  truncatedRate: number;
  points: CalibrationPoint[];
  firstSupportedTriggerTokens: number | null;
  note: string;
}
