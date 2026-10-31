/**
 * pi-cache — calibration fixtures.
 *
 * One responsibility: the small, self-contained repair tasks the sweep
 * grades. Each fixture carries a broken source, the corrected source, the
 * test that tells them apart, and the words the user says. Nothing here
 * touches the filesystem; `Repo` materialises a fixture.
 */

import type { Fixture } from "./protocol.ts";

const PARSE_PRICE: Fixture = {
  id: "parse-price",
  kind: "tail",
  file: "src/price.js",
  broken: [
    "export function parsePrice(text) {",
    "  const value = Number(text);",
    "  return Math.round(value * 100);",
    "}",
    "",
  ].join("\n"),
  fixed: [
    "export function parsePrice(text) {",
    "  const cleaned = String(text).replace(/[^0-9.-]/g, \"\");",
    "  const value = Number(cleaned);",
    "  if (!Number.isFinite(value)) return NaN;",
    "  return Math.round(value * 100);",
    "}",
    "",
  ].join("\n"),
  test: [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { parsePrice } from "../src/price.js";',
    "",
    'test("parsePrice accepts currency decoration", () => {',
    '  assert.equal(parsePrice("$12.50"), 1250);',
    '  assert.equal(parsePrice("7"), 700);',
    '  assert.equal(parsePrice("1,234.05"), 123405);',
    "});",
    "",
  ].join("\n"),
  task: "Make the price parser accept the decorated input the warehouse feed sends us.",
};

const CLAMP_RATIO: Fixture = {
  id: "clamp-ratio",
  kind: "tail",
  file: "src/ratio.js",
  broken: [
    "export function clampRatio(value) {",
    "  return Math.round(value * 1000) / 1000;",
    "}",
    "",
  ].join("\n"),
  fixed: [
    "export function clampRatio(value) {",
    "  const bounded = Math.min(1, Math.max(0, value));",
    "  return Math.round(bounded * 1000) / 1000;",
    "}",
    "",
  ].join("\n"),
  test: [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { clampRatio } from "../src/ratio.js";',
    "",
    'test("clampRatio stays inside the unit interval", () => {',
    "  assert.equal(clampRatio(-0.5), 0);",
    "  assert.equal(clampRatio(1.4), 1);",
    "  assert.equal(clampRatio(0.12345), 0.123);",
    "});",
    "",
  ].join("\n"),
  task: "The ratio helper must never leave the unit interval; the dashboard asserts on it.",
};

const CHUNK_ITEMS: Fixture = {
  id: "chunk-items",
  kind: "history",
  file: "src/chunk.js",
  broken: [
    "export function chunk(items, size) {",
    "  const out = [];",
    "  for (let i = 0; i < items.length; i += size) {",
    "    out.push(items.slice(i, i + size + 1));",
    "  }",
    "  return out;",
    "}",
    "",
  ].join("\n"),
  fixed: [
    "export function chunk(items, size) {",
    "  const out = [];",
    "  for (let i = 0; i < items.length; i += size) {",
    "    out.push(items.slice(i, i + size));",
    "  }",
    "  return out;",
    "}",
    "",
  ].join("\n"),
  test: [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { chunk } from "../src/chunk.js";',
    "",
    'test("chunk splits without overlapping", () => {',
    "  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);",
    "  assert.deepEqual(chunk([], 3), []);",
    "});",
    "",
  ].join("\n"),
  task: "The batching helper we looked at earlier still produces overlapping batches. Give me the corrected file.",
  decision: "Decision from earlier: batching must stay a pure function, so no mutation of the input array.",
};

const MERGE_INTERVALS: Fixture = {
  id: "merge-intervals",
  kind: "history",
  file: "src/intervals.js",
  broken: [
    "export function mergeIntervals(list) {",
    "  return list.slice().sort((a, b) => a[0] - b[0]).map((iv) => iv.slice());",
    "}",
    "",
  ].join("\n"),
  fixed: [
    "export function mergeIntervals(list) {",
    "  const sorted = list.slice().sort((a, b) => a[0] - b[0]);",
    "  const out = [];",
    "  for (const interval of sorted) {",
    "    const last = out[out.length - 1];",
    "    if (last && interval[0] <= last[1]) {",
    "      last[1] = Math.max(last[1], interval[1]);",
    "    } else {",
    "      out.push(interval.slice());",
    "    }",
    "  }",
    "  return out;",
    "}",
    "",
  ].join("\n"),
  test: [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { mergeIntervals } from "../src/intervals.js";',
    "",
    'test("mergeIntervals merges touching ranges", () => {',
    "  const input = [[1, 3], [2, 6], [8, 10], [10, 11]];",
    "  assert.deepEqual(mergeIntervals(input), [[1, 6], [8, 11]]);",
    "  assert.deepEqual(input, [[1, 3], [2, 6], [8, 10], [10, 11]]);",
    "});",
    "",
  ].join("\n"),
  task: "The interval merger we discussed earlier never merges anything. Give me the corrected file.",
  decision: "Decision from earlier: callers keep their own arrays, so the merger must not mutate its input.",
};

export const FIXTURES: readonly Fixture[] = [PARSE_PRICE, CLAMP_RATIO, CHUNK_ITEMS, MERGE_INTERVALS];

/** Look a fixture up by id. */
export function fixtureById(id: string): Fixture {
  const found = FIXTURES.find((fixture) => fixture.id === id);
  if (!found) throw new Error(`unknown fixture: ${id}`);
  return found;
}
