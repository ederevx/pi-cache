# Calibration harness

The degradation trigger in `src/context-degradation.ts` is a policy guess
(100 000/200 000 tokens on an uncapped window). This directory holds the
measurement that is supposed to replace the guess, and nothing here is
allowed to pretend to more precision than it measures.

## What it measures

For a pinned model and configuration, each task is run twice from the same
repository state at each of the protocol's lengths:

- **full leg** - the whole history is sent.
- **digest leg** - the span pi-cache would drop is replaced by the digest
  `SpanDigest` produces for it, keeping the same tail. This is the
  *closed-book* ablation: what survives if the model may not read the dropped
  span again. The shipped fast path also appends the deterministic transcript
  pointer that `src/fastcompact.ts` writes, and this harness deliberately does
  not, so the digest numbers bound recall from the digest alone.

Both legs get the same continuation instruction, the same output limit and
the same grading. Two contrasts come out of it:

    delta(L) = digest success(L) - full success(L)
    B(L)     = full success(32k) - full success(L)

`delta` says whether compaction is tolerable at that length; `B` says
whether long history costs the full leg anything. Each contrast is printed as
the paired discriminant - wins minus losses over the pairs both legs graded -
beside the marginal success rate of each leg, whose denominator is that leg's
own usable cells, so the two can differ by a cell when a completion was
unusable. A quality-driven trigger
needs **both**: evidence that the full leg lost material quality *and* that
the digest leg is not worse. Non-inferiority alone is not a reason to
compact when the token price is zero.

## Protocol

Frozen in `protocol.ts`: lengths 32k/64k/100k/128k/200k, a 5-point
non-inferiority margin, a 5-point material full-loss margin, exact binomial
intervals, and a familywise split over the nine contrasts (`0.05 / 9`,
`looks = 1`). No interim analysis is performed, so no alpha is spent on
looks and no sequential boundary exists to stop early on. The `report.ts`
classifier returns `safe`, `harmful`, `trigger` or `inconclusive` per length
and never extrapolates past the tested range.

Histories nest in their dropped span: `DistractorStream` generates block *i*
from the fixture id and *i* alone, so the dropped span of a shorter length is
a prefix of a longer one. The sent message list is `dropped + kept tail`, so
what stays fixed is the head at index 0 and the tail at the end, not absolute
positions in the middle: every fixture's target source is either first or
last, and nothing measures a payload at a middle distance.

A cell whose completion is empty has nothing to grade - typically the output
limit spent on reasoning - so it is recorded as `unusable` and excluded from
the rates, which are then printed beside its share. Grading an empty answer as
a wrong answer would turn the output budget into a length effect; the rates
that remain are complete-case rates over the cells that had an answer, and
they do not by themselves rule out the budget selecting those cells.

A classification is conditional on these fixtures and on independent
continuation draws. A repeat is a second draw from the same task, not a
second task, so the intervals describe no spread of coding tasks and a repeat
count cannot stand in for one.

## Fixtures

Four self-contained repairs, each graded by its own `node:test` file, with
grading refused if the test file was touched before the run or changed by it:

| fixture | kind | what it isolates |
|---|---|---|
| `parse-price` | tail | the target file is in the kept tail |
| `clamp-ratio` | tail | same, different shape |
| `chunk-items` | history | the target file exists only in the dropped span |
| `merge-intervals` | history | same, different shape |

The `history` fixtures measure what compaction costs: the digest keeps the
file name, not the file body.

## Running it

Offline, deterministic (stub model, harness check only):

    PI_CALIBRATION_DRY=1 PI_CALIBRATION_LENGTHS=32000,64000 \
      node --experimental-strip-types bench/calibration/run.ts

Live, against an OpenAI-compatible endpoint:

    PI_CALIBRATION_MODEL=deepseek-v4.1-flash \
    PI_CALIBRATION_BASE_URL=https://code.verboo.ai/router/v1 \
    PI_CALIBRATION_API_KEY=... \
    PI_CALIBRATION_REPEATS=2 \
      node --experimental-strip-types bench/calibration/run.ts

Optional: `PI_CALIBRATION_FIXTURES`, `PI_CALIBRATION_OUT`,
`PI_CALIBRATION_SEED`. No credential has a default anywhere in the code.

Results land in `results/` as `{profile, observations}`; the profile carries
the model and endpoint, the lengths it covered, the seed and repeat count
(`null` when the record it was derived from never had one), the estimator,
the request limits, the grading version, the benchmark hash, the protocol
fingerprint (implementation, lengths, alpha, both margins, the token
estimator, the request limits, seed, repeats), the intervals, the
classification per length and the first tested length whose evidence supports
a trigger (or `null`).

A stored run can be re-derived under today's rules without re-running the
model:

    node --experimental-strip-types bench/calibration/recompute.ts \
      bench/calibration/results/<run>.json

It writes `<run>.recomputed.json` beside the record and leaves the raw
observations untouched.

## What it cannot say

- Lengths above the largest tested one.
- Anything about tasks outside these four templates: repeats of one template
  are not independent tasks, so intervals over repeats understate the
  uncertainty of the claim "a coding agent degrades at L".
- Anything about a different model, prompt, tool set or digest budget. A
  profile is per configuration or it is nothing.
- Router-reported `cached_tokens` is provider cache usage, not a measure of
  pi-cache: absent means unknown, not zero.
