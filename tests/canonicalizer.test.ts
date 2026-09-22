/**
 * pi-cache — system-listing canonicalizer tests.
 * Reorders skill and project_instruction entries into code-unit order,
 * leaves everything else byte-identical, and is idempotent.
 */

import { test, assert, assertEq } from "./harness.ts";
import { SystemCanonicalizer } from "../src/canonicalizer.ts";

function skill(name: string, description: string, location: string): string {
  return `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>${location}</location>\n  </skill>`;
}

function skillsText(names: Array<[string, string, string]>): string {
  return (
    "preamble\n\n<available_skills>\n" +
    names.map(([n, d, l]) => skill(n, d, l)).join("\n") +
    "\n</available_skills>\n\ntrailer"
  );
}

test("canonicalizer: sorts skill entries by name", () => {
  const text = skillsText([
    ["zeta", "z", "/a/z"],
    ["alpha", "a", "/b/a"],
    ["mid", "m", "/c/m"],
  ]);
  const canonical = SystemCanonicalizer.canonicalizeText(text);
  const names = [...canonical.matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]);
  assertEq(names.join(","), "alpha,mid,zeta");
  assert(canonical.startsWith("preamble\n\n<available_skills>"), "prefix preserved");
  assert(canonical.endsWith("</available_skills>\n\ntrailer"), "suffix preserved");
});

test("canonicalizer: sorted input is returned byte-identical", () => {
  const text = skillsText([
    ["alpha", "a", "/b/a"],
    ["zeta", "z", "/a/z"],
  ]);
  assertEq(SystemCanonicalizer.canonicalizeText(text), text);
});

test("canonicalizer: single entries are never reordered", () => {
  const text = skillsText([["zeta", "z", "/a/z"]]);
  assertEq(SystemCanonicalizer.canonicalizeText(text), text);
});

test("canonicalizer: sorts project_instructions by path", () => {
  const text =
    "Project-specific instructions and guidelines:\n\n" +
    '<project_instructions path="/z/AGENTS.md">\nZ content\n</project_instructions>\n\n' +
    '<project_instructions path="/a/AGENTS.md">\nA content\n</project_instructions>';
  const canonical = SystemCanonicalizer.canonicalizeText(text);
  const paths = [...canonical.matchAll(/path="([^"]*)"/g)].map((m) => m[1]);
  assertEq(paths.join(","), "/a/AGENTS.md,/z/AGENTS.md");
  assert(canonical.includes("A content") && canonical.includes("Z content"), "contents intact");
});

test("canonicalizer: applies to anthropic system blocks and openai system messages", () => {
  const c = new SystemCanonicalizer(true);
  const anthropic = {
    system: [{ type: "text", text: skillsText([["zeta", "z", "/a/z"], ["alpha", "a", "/b/a"]]) }],
  };
  assertEq(c.apply(anthropic), true);
  const names = [...(anthropic.system[0].text as string).matchAll(/<name>([^<]*)<\/name>/g)];
  assertEq(names[0][1], "alpha");

  const openai = {
    messages: [
      {
        role: "system",
        content: skillsText([["zeta", "z", "/a/z"], ["alpha", "a", "/b/a"]]),
      },
    ],
  };
  assertEq(c.apply(openai), true);
  const openaiNames = [...(openai.messages[0].content as string).matchAll(/<name>([^<]*)<\/name>/g)];
  assertEq(openaiNames[0][1], "alpha");
});

test("canonicalizer: untouched roles and non-text blocks are ignored", () => {
  const c = new SystemCanonicalizer(true);
  const p = {
    messages: [
      { role: "user", content: skillsText([["zeta", "z", "/a/z"], ["alpha", "a", "/b/a"]]) },
      { role: "system", content: [{ type: "image", source: "x" }] },
    ],
  };
  assertEq(c.apply(p), false, "user content and non-text blocks untouched");
  assert((p.messages[0].content as string).startsWith("preamble\n\n<available_skills>\n  <skill>\n    <name>zeta"));
});

test("canonicalizer: disabled changes nothing", () => {
  const c = new SystemCanonicalizer(false);
  const p = { system: [{ type: "text", text: skillsText([["zeta", "z", "/a/z"], ["alpha", "a", "/b/a"]]) }] };
  assertEq(c.apply(p), false);
});
