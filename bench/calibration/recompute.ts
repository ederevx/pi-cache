/**
 * pi-cache — recompute a stored calibration profile.
 *
 * One responsibility: re-derive a profile from the raw observations a stored
 * run already holds, under today's rules, so a record can be re-read after a
 * grading or fingerprint change instead of being trusted as written. The raw
 * observations are untouched: an answer truncated to nothing was never a
 * wrong answer, so it is marked unusable here rather than in the record.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { buildProfile, formatProfile } from "./report.ts";
import type { Observation } from "./protocol.ts";

/** A stored file: the profile the run wrote plus the observations behind it. */
interface StoredRun {
  profile: {
    model?: unknown;
    providerBase?: unknown;
    plannedTasks?: unknown;
    seed?: unknown;
    repeats?: unknown;
    note?: unknown;
  };
  observations: (Omit<Observation, "unusable"> & { unusable?: boolean })[];
}

/** Mark a cell unusable when there was nothing to grade. */
function withUsability(observations: StoredRun["observations"]): Observation[] {
  return observations.map((observation) => ({
    ...observation,
    unusable: observation.unusable ?? observation.answer.trim() === "",
  }));
}

/** Re-derive and rewrite one stored run beside itself. */
async function main(): Promise<void> {
  const source = process.argv[2];
  if (source === undefined) throw new Error("usage: recompute.ts <stored-run.json>");
  const stored = JSON.parse(await readFile(source, "utf8")) as StoredRun;
  const observations = withUsability(stored.observations);
  const profile = buildProfile(observations, {
    model: typeof stored.profile.model === "string" ? stored.profile.model : "unknown",
    providerBase:
      typeof stored.profile.providerBase === "string" ? stored.profile.providerBase : "unknown",
    plannedTasks:
      typeof stored.profile.plannedTasks === "number"
        ? stored.profile.plannedTasks
        : observations.length,
    note: `${typeof stored.profile.note === "string" ? stored.profile.note : ""} recomputed from ${source} under the current rules`,
    // A record without a seed keeps none: an order this run never used is not
    // provenance, so the profile says so instead of naming one.
    seed: typeof stored.profile.seed === "number" ? stored.profile.seed : null,
    repeats:
      typeof stored.profile.repeats === "number"
        ? stored.profile.repeats
        : Math.max(1, ...observations.map((observation) => observation.repeat + 1)),
  });
  const target = join(
    dirname(source),
    `${source.slice(source.lastIndexOf("/") + 1, -extname(source).length)}.recomputed.json`,
  );
  await writeFile(target, `${JSON.stringify({ profile, observations }, null, 2)}\n`, "utf8");
  process.stdout.write(`${formatProfile(profile)}\n\nrecomputed: ${target}\n`);
}

await main();
