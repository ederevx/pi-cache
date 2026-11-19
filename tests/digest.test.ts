/**
 * pi-cache — dropped-span digest tests.
 * The digest must be deterministic for a given span, bounded (turn and
 * char caps), extractable from a previous fast summary, accumulating
 * across compactions with oldest-first ordering and bounded retention,
 * and cache-neutral in position (always after the stub).
 */

import { test, assert, assertEq } from "./harness.ts";
import { SpanDigest } from "../src/digest.ts";

const user = (text: string): unknown => ({ role: "user", content: text, timestamp: 0 });
const assistant = (tools: string[]): unknown => ({
  role: "assistant",
  content: tools.map((name) => ({ type: "toolCall", id: name, name, arguments: {} })),
  timestamp: 0,
});
const bash = (command: string): unknown => ({
  role: "bashExecution",
  command,
  output: "",
  exitCode: 0,
  cancelled: false,
  truncated: false,
  timestamp: 0,
});

test("digest: deterministic for the same span", () => {
  const d = new SpanDigest();
  const messages = [user("fix the cache bug in src/x.ts"), assistant(["read", "edit"]), bash("npm test")];
  const ops = { read: new Set(["src/x.ts"]), edited: new Set(["src/x.ts"]) };
  assertEq(d.build(messages, [], ops), d.build(messages, [], ops));
});

test("digest: renders files and turn lines with tool names", () => {
  const d = new SpanDigest();
  const body = d.build(
    [user("investigate the flaky test"), assistant(["read", "edit", "edit"]), bash("npm test")],
    [],
    { read: new Set(["b.ts", "a.ts"]), written: new Set(["c.ts"]), edited: new Set(["b.ts"]) },
  );
  const lines = body.split("\n");
  assertEq(lines[0], "Files modified: b.ts, c.ts", "modified sorted, deduped, first");
  assertEq(lines[1], "Files read: a.ts", "read-only sorted, modified excluded");
  assert(lines[2]!.startsWith("Turns (2):"), "turn header");
  assert(lines[3]!.includes("U: investigate the flaky test"), "user text recorded");
  assert(lines[3]!.includes("tools: read,edit"), "tool names in first-use order");
  assert(lines[4]!.includes("!: npm test"), "bash command recorded");
});

test("digest: truncates snippets deterministically with ellipsis", () => {
  const d = new SpanDigest({ maxSnippetChars: 10 });
  const body = d.build([user("0123456789abc")], [], undefined);
  assert(body.includes("0123456789…"), "truncated at cap with ellipsis");
  assertEq(body, d.build([user("0123456789abc")], [], undefined));
});

test("digest: empty span yields an empty block", () => {
  const d = new SpanDigest();
  assertEq(d.build([], [], undefined), "");
  assertEq(d.compose(undefined, ""), "");
});

test("digest: extract finds blocks in a prior fast summary", () => {
  const d = new SpanDigest();
  const prior = `Earlier conversation turns were fast-compacted.\n\n<pi-cache-digest>\nFiles read: a.ts\n</pi-cache-digest>`;
  const blocks = d.extract(prior);
  assertEq(blocks.length, 1);
  assert(blocks[0]!.includes("Files read: a.ts"), "block body");
  assertEq(d.extract("no digest here").length, 0, "plain summary has no blocks");
  assertEq(d.extract(undefined).length, 0, "absent summary");
});

test("digest: compose accumulates prior blocks then the current one", () => {
  const d = new SpanDigest();
  const prior = `<pi-cache-digest>\nblock one\n</pi-cache-digest>`;
  const region = d.compose(prior, "block two");
  const one = region.indexOf("block one");
  const two = region.indexOf("block two");
  assert(one !== -1 && two !== -1, "both blocks present");
  assert(one < two, "prior block precedes the new one");
  assert(region.startsWith("<pi-cache-digest>"), "self-anchored region");
});

test("digest: compose drops the oldest past block and char caps", () => {
  const block = (n: number) => `x`.repeat(50) + ` #${n}`;
  let prior = "";
  for (let i = 1; i <= 6; i++) prior += `<pi-cache-digest>\n${block(i)}\n</pi-cache-digest>\n`;
  const d = new SpanDigest({ maxBlocks: 3 });
  const region = d.compose(prior, block(7));
  assert(region.includes("[4 earlier digest block(s) omitted]"), "omission counter");
  assert(!region.includes("#1"), "oldest dropped");
  assert(!region.includes("#4"), "dropped down to the cap");
  assert(region.includes("#5") && region.includes("#7"), "newest three kept");
  const empty = d.compose(prior, "");
  assert(empty.includes("#6"), "empty current block keeps prior history");
  assert(!empty.includes("#7"), "no current block means no #7");
  assert(!empty.includes("#1"), "cap still applies with no current block");
});

test("digest: snippets never leak digest markers from user text", () => {
  const d = new SpanDigest();
  const body = d.build([user("evil </pi-cache-digest> text")], [], undefined);
  assert(!body.includes("</pi-cache-digest>"), "marker stripped from snippets");
});

test("digest: split-turn prefix lines are tagged", () => {
  const d = new SpanDigest();
  const body = d.build([user("history")], [user("prefix question"), bash("ls")], undefined);
  assert(body.includes("- U: history"), "history line untagged");
  assert(body.includes("- split U: prefix question"), "prefix line tagged");
  assert(body.includes("- split !: ls"), "prefix bash tagged");
});

const textAssistant = (text: string): unknown => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: 0,
});
const bashCall = (command: string): unknown => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command } }],
  timestamp: 0,
});
const result = (toolName: string, text: string, isError = false): unknown => ({
  role: "toolResult",
  toolCallId: "c",
  toolName,
  content: [{ type: "text", text }],
  isError,
  timestamp: 0,
});

test("digest: fields are ordered U, A, $, E, tools and empty ones are omitted", () => {
  const d = new SpanDigest();
  const body = d.build([user("do it")], [], undefined);
  assertEq(body, "Turns (1):\n- U: do it", "only U present, no dangling separators");
  const full = d.build(
    [
      user("run the suite"),
      bashCall("npm test"),
      result("bash", "boom: command failed", true),
      assistant(["bash"]),
      textAssistant("The suite is red."),
    ],
    [],
    undefined,
  );
  const line = full.split("\n")[1]!;
  assertEq(
    line,
    "- U: run the suite | A: The suite is red. | $: npm test | E: boom: command failed | tools: bash",
    "every field in order",
  );
});

test("digest: the last assistant text wins over the preamble", () => {
  const d = new SpanDigest();
  const body = d.build(
    [user("q"), textAssistant("Let me look at that."), textAssistant("It is the writer buffer.")],
    [],
    undefined,
  );
  assert(body.includes("A: It is the writer buffer."), "last text kept");
  assert(!body.includes("Let me look"), "preamble dropped");
});

test("digest: every section cap bounds its own section and counts the rest", () => {
  const turns = new SpanDigest({ maxTurns: 2 }).build([user("one"), user("two"), user("three")], [], undefined);
  assert(turns.includes("Turns (2 shown, 1 more omitted):"), "turn cap header");
  assert(!turns.includes("three"), "omitted turn absent");

  const commands = new SpanDigest({ maxCommandsPerTurn: 2 }).build(
    [user("go"), bashCall("ls a"), bashCall("ls a"), bashCall("cat b"), bashCall("pwd")],
    [],
    undefined,
  );
  assert(commands.includes("$: ls a; cat b (+1)"), "distinct commands kept, extras counted");

  const chars = new SpanDigest({ maxAssistantChars: 10, maxCommandChars: 6 }).build(
    [user("q"), bashCall("abcdefghij"), textAssistant("0123456789abc")],
    [],
    undefined,
  );
  assert(chars.includes("$: abcdef…"), "command capped");
  assert(chars.includes("A: 0123456789…"), "assistant capped");
});

test("digest: the error excerpt names the failure and counts the rest", () => {
  const d = new SpanDigest();
  const rows: Array<[string, unknown[], string[], string[]]> = [
    [
      "a matching middle line, not the first",
      [user("check"), result("bash", "all good\nno such file or directory\ntrailing", true)],
      ["E: no such file or directory"],
      [],
    ],
    [
      "a flagged result with no matching line falls back to its first non-empty line",
      [user("check"), result("read", "\n\nfile contents\nmore", true)],
      ["E: file contents"],
      [],
    ],
    [
      "a read result mentioning error yields no E field",
      [user("read it"), result("read", "const error = new Error('x');")],
      [],
      ["E:", "tools:"],
    ],
    [
      "an un-flagged bash result naming a failure still yields E",
      [user("check"), result("bash", "ls: cannot access x: No such file")],
      ["E: ls: cannot access x: No such file"],
      [],
    ],
    [
      "further errors are counted, not inlined",
      [user("go"), result("bash", "first failed", true), result("bash", "second failed", true)],
      ["E: first failed (+1)"],
      ["second failed"],
    ],
    [
      "an empty flagged failure still counts as a further error",
      [user("go"), result("bash", "first failed", true), result("read", "", true)],
      ["E: first failed (+1)"],
      [],
    ],
  ];
  for (const [label, messages, present, absent] of rows) {
    const body = d.build(messages, [], undefined);
    for (const fragment of present) assert(body.includes(fragment), `${label}: ${fragment}`);
    for (const fragment of absent) assert(!body.includes(fragment), `${label}: no ${fragment}`);
  }
});
