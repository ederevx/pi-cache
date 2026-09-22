/**
 * pi-cache — deterministic system-listing canonicalizer.
 *
 * One responsibility: make the rendered system prompt byte-stable across
 * spawn configurations by reordering its two machine-built listings —
 * `<skill>` entries inside `<available_skills>` and
 * `<project_instructions path="...">` AGENTS.md entries — into code-unit
 * name/path order. pi builds both listings in raw readdir order
 * (skills.js, resource-loader.js), which is stable per directory but not
 * canonical, so identical skill sets loaded through different directories
 * or insertion paths serialize to different prefix bytes. Reordering only
 * ever swaps whole, intact entries between their first and last span;
 * entry text and all other prompt bytes are untouched, and an
 * already-sorted listing is returned unchanged.
 */

export class SystemCanonicalizer {
  constructor(private enabledOn: boolean = true) {}

  /** The live canonicalization switch (toggled from /cache-settings). */
  get enabled(): boolean {
    return this.enabledOn;
  }

  /** Turn listing canonicalization on or off in place. */
  setEnabled(enabled: boolean): void {
    this.enabledOn = enabled;
  }

  /**
   * Canonicalize every system region of the payload in place: Anthropic
   * system text blocks and openai-completions system/developer message
   * content. Returns whether any bytes changed.
   */
  apply(payload: unknown): boolean {
    if (!this.enabledOn) return false;
    if (!payload || typeof payload !== "object") return false;
    const body = payload as Record<string, unknown>;
    let changed = false;
    if (Array.isArray(body.system)) {
      for (const block of body.system as Array<Record<string, unknown>>) {
        if (block && typeof block.text === "string") {
          changed = this.canonicalizeField(block, "text") || changed;
        }
      }
    }
    const messages = body.messages as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (message?.role !== "system" && message?.role !== "developer") continue;
        if (typeof message.content === "string") {
          changed = this.canonicalizeField(message, "content") || changed;
        } else if (Array.isArray(message.content)) {
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (block && typeof block.text === "string") {
              changed = this.canonicalizeField(block, "text") || changed;
            }
          }
        }
      }
    }
    return changed;
  }

  /** Canonicalize one string field in place; reports the change. */
  private canonicalizeField(holder: Record<string, unknown>, field: string): boolean {
    const text = holder[field] as string;
    const canonical = SystemCanonicalizer.canonicalizeText(text);
    if (canonical === text) return false;
    holder[field] = canonical;
    return true;
  }

  /** Sort machine-built listings inside one system text, if present. */
  static canonicalizeText(text: string): string {
    const instructions = SystemCanonicalizer.canonicalizeSpan(
      text,
      /<project_instructions path="[^"]*">[\s\S]*?<\/project_instructions>/g,
      /<project_instructions path="([^"]*)">/,
      "\n\n",
    );
    return SystemCanonicalizer.canonicalizeSpan(
      instructions,
      /  <skill>[\s\S]*?  <\/skill>/g,
      /<name>([\s\S]*?)<\/name>/,
      "\n",
    );
  }

  /**
   * Sort the entries a pattern matches, replacing the span from the first
   * to the last match with the sorted sequence joined by `separator`.
   * Entries are compared by the key their key pattern captures (code-unit
   * order, so the result is locale-independent). A single match or an
   * already-sorted span returns the text unchanged.
   */
  private static canonicalizeSpan(
    text: string,
    entryPattern: RegExp,
    keyPattern: RegExp,
    separator: string,
  ): string {
    const matches = [...text.matchAll(entryPattern)];
    if (matches.length < 2) return text;
    const entries = matches.map((m) => m[0]);
    const sorted = [...entries].sort(SystemCanonicalizer.byEntryKey(keyPattern));
    if (sorted.every((entry, i) => entry === entries[i])) return text;
    const first = matches[0];
    const last = matches[matches.length - 1];
    const start = first.index ?? 0;
    const end = (last.index ?? 0) + last[0].length;
    return text.slice(0, start) + sorted.join(separator) + text.slice(end);
  }

  /** Code-unit comparator on the entry's captured key (never locale order). */
  private static byEntryKey(keyPattern: RegExp): (a: string, b: string) => number {
    return (a, b) => {
      const ka = keyPattern.exec(a)?.[1] ?? "";
      const kb = keyPattern.exec(b)?.[1] ?? "";
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    };
  }
}
