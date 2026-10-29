/**
 * pi-cache — deterministic dropped-span digest for fast compaction.
 *
 * One responsibility: turn the span a compaction drops (pi's
 * `messagesToSummarize` plus any split-turn prefix) into a bounded,
 * byte-deterministic extractive digest — file lists from pi's own
 * `fileOps`, one capped line per turn (first user text, last assistant
 * text, agent bash commands, first error line, tool names) — and
 * accumulate those blocks across compactions by
 * folding the previous compaction's digest blocks (found in
 * `previousSummary`, self-anchored between <pi-cache-digest> markers)
 * ahead of the new one. Everything is derived from the span content
 * alone: stable ordering, fixed truncation, no clock, no randomness —
 * the same dropped span always renders the same bytes, so the fast
 * summary stays cache-stable for a given cut. The region lives AFTER
 * the constant stub text, so the shared prefix head is byte-identical
 * whether or not a digest is present (cache-neutral). Extraction is
 * fail-open: a summary without digest blocks simply starts a new chain.
 */

export interface SpanFileOps {
  read?: Set<string>;
  written?: Set<string>;
  edited?: Set<string>;
}

export interface SpanDigestOptions {
  /** Turn lines kept per block (earliest first); extra turns are counted. */
  maxTurns?: number;
  /** Characters kept per user-text/command snippet. */
  maxSnippetChars?: number;
  /** Characters kept of the last assistant text per turn. */
  maxAssistantChars?: number;
  /** Characters kept per agent bash command. */
  maxCommandChars?: number;
  /** Agent bash commands rendered per turn before counting the rest. */
  maxCommandsPerTurn?: number;
  /** Characters kept per error excerpt. */
  maxErrorChars?: number;
  /** File entries kept per file list; extras are counted. */
  maxFiles?: number;
  /** Characters kept per block; further turns are counted, not inlined. */
  maxBlockChars?: number;
  /** Digest blocks retained across compactions (oldest dropped first). */
  maxBlocks?: number;
  /** Characters kept in the accumulated region; oldest blocks drop. */
  maxRegionChars?: number;
}

/** Self-anchoring markers around each digest block in a fast summary. */
const DIGEST_BEGIN = "<pi-cache-digest>";
const DIGEST_END = "</pi-cache-digest>";

/** Tool names rendered per turn before collapsing the rest into a count. */
const MAX_TOOL_NAMES = 8;

/** Field separator inside a turn line. */
const SEP = " | ";

/**
 * A tool result is an error when pi flags it, or when a bash result's
 * text names a failure the flag alone would miss.
 */
const ERROR_RE =
  /\b(error|errors|failed|failure|fatal|panic|exception|traceback|denied|not found|no such file|exit code [1-9]\d*|command failed)\b/i;

/** One turn's collected fields, reset at every flush. */
interface TurnState {
  userText: string;
  assistantText: string;
  commands: string[];
  errorText: string;
  errors: number;
  tools: string[];
}

export class SpanDigest {
  private readonly maxTurns: number;
  private readonly maxSnippetChars: number;
  private readonly maxAssistantChars: number;
  private readonly maxCommandChars: number;
  private readonly maxCommandsPerTurn: number;
  private readonly maxErrorChars: number;
  private readonly maxFiles: number;
  private readonly maxBlockChars: number;
  private readonly maxBlocks: number;
  private readonly maxRegionChars: number;

  constructor(opts: SpanDigestOptions = {}) {
    this.maxTurns = opts.maxTurns ?? 40;
    this.maxSnippetChars = opts.maxSnippetChars ?? 240;
    this.maxAssistantChars = opts.maxAssistantChars ?? 160;
    this.maxCommandChars = opts.maxCommandChars ?? 100;
    this.maxCommandsPerTurn = opts.maxCommandsPerTurn ?? 2;
    this.maxErrorChars = opts.maxErrorChars ?? 100;
    this.maxFiles = opts.maxFiles ?? 20;
    this.maxBlockChars = opts.maxBlockChars ?? 12000;
    this.maxBlocks = opts.maxBlocks ?? 8;
    this.maxRegionChars = opts.maxRegionChars ?? 24000;
  }

  /** The current span's block body; empty when nothing worth recording. */
  build(
    messages: readonly unknown[],
    turnPrefixMessages: readonly unknown[],
    fileOps: SpanFileOps | undefined,
  ): string {
    const lines: string[] = [];
    this.fileLines(fileOps, lines);
    const history = this.turnLines(messages, "");
    const prefix = this.turnLines(turnPrefixMessages, "split");
    const turnLines = [...history, ...prefix];
    if (turnLines.length > 0) {
      const shown = turnLines.slice(0, this.maxTurns);
      lines.push(
        turnLines.length > this.maxTurns
          ? `Turns (${shown.length} shown, ${turnLines.length - shown.length} more omitted):`
          : `Turns (${shown.length}):`,
      );
      lines.push(...shown);
    }
    return this.capBlock(lines);
  }

  /** Prior digest block bodies from a previous fast summary, oldest first. */
  extract(previousSummary: string | undefined): string[] {
    if (typeof previousSummary !== "string" || previousSummary.length === 0) return [];
    const bodies: string[] = [];
    const open = `${DIGEST_BEGIN}\n`;
    const close = `\n${DIGEST_END}`;
    let cursor = 0;
    while (true) {
      const start = previousSummary.indexOf(open, cursor);
      if (start === -1) break;
      const bodyStart = start + open.length;
      const end = previousSummary.indexOf(close, bodyStart);
      if (end === -1) break;
      const body = previousSummary.slice(bodyStart, end);
      if (body.length > 0) bodies.push(body);
      cursor = end + close.length;
    }
    return bodies;
  }

  /**
   * The accumulated digest region: prior blocks from `previousSummary`
   * (oldest first) plus the current block, bounded by dropping the
   * oldest. Empty when there is nothing to record at all.
   */
  compose(previousSummary: string | undefined, currentBlock: string): string {
    const prior = this.extract(previousSummary);
    const blocks = currentBlock.length > 0 ? [...prior, currentBlock] : prior;
    if (blocks.length === 0) return "";
    let omitted = 0;
    while (
      blocks.length > 1 &&
      (blocks.length > this.maxBlocks || this.regionChars(blocks) > this.maxRegionChars)
    ) {
      blocks.shift();
      omitted++;
    }
    const parts: string[] = [];
    if (omitted > 0) parts.push(`[${omitted} earlier digest block(s) omitted]`);
    for (const block of blocks) parts.push(`${DIGEST_BEGIN}\n${block}\n${DIGEST_END}`);
    return parts.join("\n");
  }

  /** File-list lines: modified first, then read-only, both sorted. */
  private fileLines(fileOps: SpanFileOps | undefined, lines: string[]): void {
    if (!fileOps) return;
    const modified = new Set<string>();
    for (const f of fileOps.written ?? []) if (typeof f === "string") modified.add(f);
    for (const f of fileOps.edited ?? []) if (typeof f === "string") modified.add(f);
    const mod = [...modified].sort();
    const read = [...(fileOps.read ?? [])]
      .filter((f) => typeof f === "string" && !modified.has(f))
      .sort();
    this.fileLine("Files modified", mod, lines);
    this.fileLine("Files read", read, lines);
  }

  private fileLine(label: string, files: string[], lines: string[]): void {
    if (files.length === 0) return;
    const shown = files.slice(0, this.maxFiles);
    const suffix =
      files.length > this.maxFiles ? ` (+${files.length - this.maxFiles} more)` : "";
    lines.push(`${label}: ${shown.join(", ")}${suffix}`);
  }

  /** One line per turn: first user text, last assistant text, bash commands, first error, tool names. */
  private turnLines(messages: readonly unknown[], label: string): string[] {
    const lines: string[] = [];
    const tag = label.length > 0 ? `${label} ` : "";
    const turn = this.newTurn();
    const flush = (): void => {
      const line = this.turnLine(tag, turn);
      if (line.length > 0) lines.push(line);
      this.resetTurn(turn);
    };
    for (const message of messages) {
      const m = message as
        | { role?: unknown; content?: unknown; command?: unknown; toolName?: unknown; isError?: unknown }
        | undefined;
      if (!m || typeof m !== "object") continue;
      if (m.role === "user") {
        flush();
        if (turn.userText.length === 0) turn.userText = this.userSnippet(m.content);
      } else if (m.role === "assistant") {
        this.toolNames(m.content, turn.tools);
        this.assistantText(m.content, turn);
        this.agentCommands(m.content, turn);
      } else if (m.role === "toolResult") {
        this.errorExcerpt(m, turn);
      } else if (m.role === "bashExecution") {
        flush();
        const cmd = this.snippet(typeof m.command === "string" ? m.command : "", this.maxSnippetChars);
        if (cmd.length > 0) lines.push(`- ${tag}!: ${cmd}`);
      }
      // custom, system, and unknown roles carry no digest line.
    }
    flush();
    return lines;
  }

  private newTurn(): TurnState {
    return { userText: "", assistantText: "", commands: [], errorText: "", errors: 0, tools: [] };
  }

  private resetTurn(turn: TurnState): void {
    turn.userText = "";
    turn.assistantText = "";
    turn.commands = [];
    turn.errorText = "";
    turn.errors = 0;
    turn.tools = [];
  }

  /** The rendered turn line, or an empty string when the turn carries nothing. */
  private turnLine(tag: string, turn: TurnState): string {
    const empty =
      turn.userText.length === 0 &&
      turn.assistantText.length === 0 &&
      turn.commands.length === 0 &&
      turn.errorText.length === 0 &&
      turn.tools.length === 0;
    if (empty) return "";
    const fields = [`U: ${turn.userText.length > 0 ? turn.userText : "(no text)"}`];
    if (turn.assistantText.length > 0) fields.push(`A: ${turn.assistantText}`);
    if (turn.commands.length > 0) fields.push(`$: ${this.commandField(turn.commands)}`);
    if (turn.errorText.length > 0) {
      const extra = turn.errors > 1 ? ` (+${turn.errors - 1})` : "";
      fields.push(`E: ${turn.errorText}${extra}`);
    }
    if (turn.tools.length > 0) {
      const names = turn.tools.slice(0, MAX_TOOL_NAMES).join(",");
      const more = turn.tools.length > MAX_TOOL_NAMES ? `+${turn.tools.length - MAX_TOOL_NAMES}` : "";
      fields.push(`tools: ${names}${more}`);
    }
    return `- ${tag}${fields.join(SEP)}`;
  }

  /** The `$:` field: the first few distinct commands, then a count of the rest. */
  private commandField(commands: readonly string[]): string {
    const shown = commands.slice(0, this.maxCommandsPerTurn);
    const extra = commands.length - shown.length;
    const head = shown.join("; ");
    return extra > 0 ? `${head} (+${extra})` : head;
  }

  /** The last assistant text of the turn: its conclusion, not its preamble. */
  private assistantText(content: unknown, turn: TurnState): void {
    if (!Array.isArray(content)) return;
    let text = "";
    for (const part of content) {
      const block = part as { type?: unknown; text?: unknown } | undefined;
      if (block && typeof block === "object" && block.type === "text") {
        text += `${typeof block.text === "string" ? block.text : ""} `;
      }
    }
    const excerpt = this.snippet(text, this.maxAssistantChars);
    if (excerpt.length > 0) turn.assistantText = excerpt;
  }

  /** Agent bash commands from an assistant message, deduped in first-use order. */
  private agentCommands(content: unknown, turn: TurnState): void {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const block = part as { type?: unknown; name?: unknown; arguments?: unknown } | undefined;
      if (!block || typeof block !== "object") continue;
      if (block.type !== "toolCall" || block.name !== "bash") continue;
      const args = block.arguments as { command?: unknown } | undefined;
      if (!args || typeof args.command !== "string") continue;
      const cmd = this.snippet(args.command, this.maxCommandChars);
      if (cmd.length > 0 && !turn.commands.includes(cmd)) turn.commands.push(cmd);
    }
  }

  /** First error excerpt of the turn, from a flagged or bash-failing result. */
  private errorExcerpt(
    m: { toolName?: unknown; isError?: unknown; content?: unknown },
    turn: TurnState,
  ): void {
    const flagged = m.isError === true;
    const text = this.resultText(m.content);
    // Only bash results are scanned by text: source code read by other tools is full of "error".
    if (!flagged && !(m.toolName === "bash" && ERROR_RE.test(text))) return;
    const excerpt = this.snippet(this.errorLine(text, flagged), this.maxErrorChars);
    if (excerpt.length === 0) return;
    turn.errors += 1;
    if (turn.errorText.length === 0) turn.errorText = excerpt;
  }

  /** The first line naming a failure, else (for a flagged result) the first non-empty line. */
  private errorLine(text: string, flagged: boolean): string {
    const lines = text.split(/\r?\n/);
    for (const line of lines) if (ERROR_RE.test(line)) return line;
    if (!flagged) return "";
    return lines.find((line) => line.trim().length > 0) ?? "";
  }

  /** A tool result's text blocks joined by newlines, whitespace unsquashed. */
  private resultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const part of content) {
      const block = part as { type?: unknown; text?: unknown } | undefined;
      if (block && typeof block === "object" && block.type === "text") {
        parts.push(typeof block.text === "string" ? block.text : "");
      }
    }
    return parts.join("\n");
  }

  /** First text snippet of a user message's content (string or blocks). */
  private userSnippet(content: unknown): string {
    if (typeof content === "string") return this.snippet(content, this.maxSnippetChars);
    if (!Array.isArray(content)) return "";
    let text = "";
    for (const part of content) {
      const block = part as { type?: unknown; text?: unknown } | undefined;
      if (block && typeof block === "object" && block.type === "text") {
        text += `${typeof block.text === "string" ? block.text : ""} `;
      }
    }
    return this.snippet(text, this.maxSnippetChars);
  }

  /** Tool-call names from an assistant message, deduped in first-use order. */
  private toolNames(content: unknown, out: string[]): void {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const block = part as { type?: unknown; name?: unknown } | undefined;
      if (!block || typeof block !== "object") continue;
      if (block.type !== "toolCall" || typeof block.name !== "string") continue;
      if (!out.includes(block.name)) out.push(block.name);
    }
  }

  /** Deterministic one-line snippet: squash whitespace, fixed truncation. */
  private snippet(raw: string, limit: number): string {
    const text = raw
      .replace(/\s+/g, " ")
      .trim()
      .split(DIGEST_BEGIN)
      .join("")
      .split(DIGEST_END)
      .join("");
    if (text.length <= limit) return text;
    let cut = text.slice(0, limit);
    // Never end mid-surrogate: deterministic and renderable.
    const code = cut.charCodeAt(cut.length - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut = cut.slice(0, -1);
    return `${cut}…`;
  }

  /** Drop trailing turn lines past the block char cap, with a counter. */
  private capBlock(lines: string[]): string {
    let total = 0;
    let firstTurn = -1;
    for (let i = 0; i < lines.length; i++) {
      const isTurn = lines[i].startsWith("- ");
      if (isTurn && firstTurn === -1) firstTurn = i;
      total += lines[i].length + 1;
    }
    if (total <= this.maxBlockChars) return lines.join("\n");
    if (firstTurn === -1) return lines.join("\n");
    const kept: string[] = [];
    let used = 0;
    let dropped = 0;
    for (let i = 0; i < lines.length; i++) {
      const isTurn = i >= firstTurn;
      if (isTurn && used + lines[i].length + 1 > this.maxBlockChars) {
        dropped = lines.length - i;
        break;
      }
      kept.push(lines[i]);
      used += lines[i].length + 1;
    }
    if (dropped > 0) kept.push(`[+${dropped} more turns omitted]`);
    return kept.join("\n");
  }

  private regionChars(blocks: readonly string[]): number {
    return blocks.reduce((sum, b) => sum + b.length, 0);
  }
}
