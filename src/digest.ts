/**
 * pi-cache — deterministic dropped-span digest for fast compaction.
 *
 * One responsibility: turn the span a compaction drops (pi's
 * `messagesToSummarize` plus any split-turn prefix) into a bounded,
 * byte-deterministic extractive digest — file lists from pi's own
 * `fileOps`, one capped line per turn (first user text, bash commands,
 * tool names) — and accumulate those blocks across compactions by
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

export class SpanDigest {
  private readonly maxTurns: number;
  private readonly maxSnippetChars: number;
  private readonly maxFiles: number;
  private readonly maxBlockChars: number;
  private readonly maxBlocks: number;
  private readonly maxRegionChars: number;

  constructor(opts: SpanDigestOptions = {}) {
    this.maxTurns = opts.maxTurns ?? 40;
    this.maxSnippetChars = opts.maxSnippetChars ?? 80;
    this.maxFiles = opts.maxFiles ?? 20;
    this.maxBlockChars = opts.maxBlockChars ?? 4000;
    this.maxBlocks = opts.maxBlocks ?? 8;
    this.maxRegionChars = opts.maxRegionChars ?? 8000;
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

  /** One line per turn: first user text, bash commands, tool names. */
  private turnLines(messages: readonly unknown[], label: string): string[] {
    const lines: string[] = [];
    const tag = label.length > 0 ? `${label} ` : "";
    let userText = "";
    let tools: string[] = [];
    const flush = (): void => {
      if (userText.length === 0 && tools.length === 0) return;
      const head = userText.length > 0 ? userText : "(no text)";
      const names = tools.slice(0, MAX_TOOL_NAMES).join(",");
      const more = tools.length > MAX_TOOL_NAMES ? `+${tools.length - MAX_TOOL_NAMES}` : "";
      const tail = tools.length > 0 ? ` | tools: ${names}${more}` : "";
      lines.push(`- ${tag}U: ${head}${tail}`);
      userText = "";
      tools = [];
    };
    for (const message of messages) {
      const m = message as
        | { role?: unknown; content?: unknown; command?: unknown }
        | undefined;
      if (!m || typeof m !== "object") continue;
      if (m.role === "user") {
        flush();
        if (userText.length === 0) userText = this.userSnippet(m.content);
      } else if (m.role === "assistant") {
        this.toolNames(m.content, tools);
      } else if (m.role === "bashExecution") {
        flush();
        const cmd = this.snippet(typeof m.command === "string" ? m.command : "");
        if (cmd.length > 0) lines.push(`- ${tag}!: ${cmd}`);
      }
      // toolResult, custom, system, and unknown roles carry no digest line.
    }
    flush();
    return lines;
  }

  /** First text snippet of a user message's content (string or blocks). */
  private userSnippet(content: unknown): string {
    if (typeof content === "string") return this.snippet(content);
    if (!Array.isArray(content)) return "";
    let text = "";
    for (const part of content) {
      const block = part as { type?: unknown; text?: unknown } | undefined;
      if (block && typeof block === "object" && block.type === "text") {
        text += `${typeof block.text === "string" ? block.text : ""} `;
      }
    }
    return this.snippet(text);
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
  private snippet(raw: string): string {
    const text = raw
      .replace(/\s+/g, " ")
      .trim()
      .split(DIGEST_BEGIN)
      .join("")
      .split(DIGEST_END)
      .join("");
    if (text.length <= this.maxSnippetChars) return text;
    let cut = text.slice(0, this.maxSnippetChars);
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
