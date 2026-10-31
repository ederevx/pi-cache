/**
 * pi-cache — calibration histories.
 *
 * One responsibility: turn a fixture and a target length into the message
 * list a continuation sees, split at the boundary pi-cache compacts. The
 * distractor stream is generated from the fixture id and the block index
 * alone, so the history for a shorter length is a prefix of the history
 * for a longer one: length is the only thing that changes, and the
 * task-bearing head and tail sit at fixed absolute positions.
 */

import type { Fixture } from "./protocol.ts";
import { CHARS_PER_TOKEN } from "./protocol.ts";

/** The message shape pi hands a compaction span and the digest reads. */
export interface CalMessage {
  role: "user" | "assistant" | "toolResult";
  toolName?: string;
  isError?: boolean;
  content: { type: "text"; text: string }[];
}

/** Estimated prompt tokens for text, at the protocol's characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimated prompt tokens for a message list. */
export function estimateMessagesTokens(messages: readonly CalMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/** The same estimate, reading the message body. */
export function messageTokens(message: CalMessage): number {
  return estimateTokens(message.content.map((part) => part.text).join(""));
}

/** The answer format, identical in every leg, length, and repeat. */
export function continuationInstruction(file: string): string {
  return [
    `Reply with exactly one fenced \`\`\`js code block containing the complete`,
    `corrected contents of ${file}, and nothing else.`,
  ].join(" ");
}

/** Deterministic distractor blocks, one per index, seeded by fixture id. */
export class DistractorStream {
  private readonly seed: number;

  constructor(fixtureId: string) {
    let seed = 2166136261;
    for (const char of fixtureId) {
      seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    }
    this.seed = seed;
  }

  /** The block at `index`; identical for every call and every target length. */
  block(index: number): CalMessage[] {
    const area = (this.seed + index * 7919) % 997;
    const module = `module-${1000 + ((this.seed + index * 131) % 900)}`;
    const size = 96 + ((this.seed + index * 37) % 48);
    const lines: string[] = [];
    for (let i = 0; i < size; i += 1) {
      const value = (this.seed + index * 2654435761 + i * 40503) >>> 0;
      lines.push(
        `  case ${value % 100000}: return normalize(${value % 1000}, ${(value >>> 8) % 97});`,
      );
    }
    const listing = [
      `// ${module}.js — generated slice ${area}, do not edit by hand`,
      "export function slice(value) {",
      "  switch (value.kind) {",
      ...lines,
      "  }",
      "}",
      "",
    ].join("\n");
    return [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Re-run the ${module} slice for area ${area} and tell me whether the flake reproduces.`,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Ran the ${module} slice twice; it is clean, no assertion failures.`,
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: listing }],
      },
    ];
  }
}

/** A history split at the compaction boundary. */
export interface CalHistory {
  /** Everything the model sees in the full leg. */
  full: CalMessage[];
  /** The span pi-cache would drop. */
  dropped: CalMessage[];
  /** The tail that survives compaction. */
  tail: CalMessage[];
  /** Files the dropped span read, for the digest's file list. */
  fileOps: { read: Set<string>; edited: Set<string>; written: Set<string> };
  estimatedTokens: number;
}

/** Builds the fixture's head, its constant tail, and the distractor fill. */
export class HistoryBuilder {
  /** The head: the target file as it was read long ago. History fixtures only. */
  head(fixture: Fixture): CalMessage[] {
    if (fixture.kind !== "history") return [];
    return [
      {
        role: "user",
        content: [{ type: "text", text: `Have a look at ${fixture.file} and tell me what it does.` }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Here is ${fixture.file} as it stands.` }],
      },
      {
        role: "toolResult",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: `${fixture.file}\n${fixture.broken}` }],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: fixture.decision ?? "Keep the signature as it is.",
          },
        ],
      },
    ];
  }

  /** The constant tail: the request, the failure, and the answer format. */
  tail(fixture: Fixture): CalMessage[] {
    const messages: CalMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: fixture.task }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              fixture.kind === "tail"
                ? `Reading the failing test and ${fixture.file}.`
                : `The file was read earlier in this session; the failure is still there.`,
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [
          {
            type: "text",
            text: [
              "$ node --test test/",
              "not ok 1 - the fixture contract",
              `  file: ${fixture.file}`,
              "  error: assertion failed",
              ...(fixture.kind === "tail"
                ? [
                    "",
                    `read ${fixture.file}:`,
                    fixture.broken,
                  ]
                : [""]),
            ].join("\n"),
          },
        ],
      },
    ];
    if (fixture.kind === "tail" && fixture.decision) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: fixture.decision }],
      });
    }
    messages.push({
      role: "user",
      content: [{ type: "text", text: continuationInstruction(fixture.file) }],
    });
    return messages;
  }

  /** Fill a fixture up to `targetTokens`, nesting shorter lengths into longer. */
  build(fixture: Fixture, targetTokens: number): CalHistory {
    const head = this.head(fixture);
    const tail = this.tail(fixture);
    const stream = new DistractorStream(fixture.id);
    const fixed = estimateMessagesTokens([...head, ...tail]);
    if (targetTokens <= fixed) {
      throw new Error(
        `target ${targetTokens} is below the fixture skeleton (${fixed} tokens) for ${fixture.id}`,
      );
    }
    const dropped: CalMessage[] = [...head];
    const fileOps = { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() };
    if (fixture.kind === "history") fileOps.read.add(fixture.file);
    let index = 0;
    while (estimateMessagesTokens([...dropped, ...tail]) < targetTokens) {
      const block = stream.block(index);
      dropped.push(...block);
      const listing = block[2]?.content[0]?.text ?? "";
      const named = /^\/\/ (\S+)\.js/.exec(listing)?.[1];
      if (named) fileOps.read.add(`src/legacy/${named}.js`);
      index += 1;
    }
    const full = [...dropped, ...tail];
    return {
      full,
      dropped,
      tail,
      fileOps,
      estimatedTokens: estimateMessagesTokens(full),
    };
  }
}
