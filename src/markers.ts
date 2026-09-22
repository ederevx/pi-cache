/**
 * pi-cache — cache_control marker traversal.
 *
 * One responsibility: locate every Anthropic-style `cache_control` marker
 * in a provider payload (system text blocks, tool entries, message content
 * blocks) with its location, so the anchor and retention transforms share
 * one traversal instead of duplicating shape-specific walks. Detection is
 * deliberately shape-agnostic: any block or tool entry carrying a
 * `cache_control` object counts, wherever pi's provider layer pinned it.
 */

export interface MessageLike {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

export interface MarkerRef {
  /** Which region the marker lives in. */
  region: "system" | "tools" | "messages";
  /** The block/entry object carrying the marker (mutable reference). */
  holder: Record<string, unknown>;
  /** For message markers: the message index; -1 elsewhere. */
  messageIndex: number;
  /** For message markers: 1-based cumulative block position of the holder
   *  across the message list; -1 elsewhere. */
  position: number;
}

/** The per-region marker index a scan builds. */
export interface MarkerIndex {
  system: MarkerRef[];
  tools: MarkerRef[];
  messages: MarkerRef[];
}

export class Markers {
  /** True when the value looks like an Anthropic cache_control marker. */
  static isCacheControl(value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>).type === "ephemeral"
    );
  }

  /** The system region's blocks, whatever shape the provider uses. */
  static systemBlocks(body: Record<string, unknown>): Array<Record<string, unknown>> {
    const system = body.system;
    if (Array.isArray(system)) {
      return system.filter(
        (b): b is Record<string, unknown> => typeof b === "object" && b !== null,
      );
    }
    return [];
  }

  /** The message's content blocks, or a one-block view of string content.
   *  Array items that are not objects get an object wrapper so position
   *  counting still sees them. */
  static contentBlocks(message: MessageLike): Array<Record<string, unknown>> {
    if (Array.isArray(message.content)) {
      return (message.content as unknown[]).map((b) =>
        typeof b === "object" && b !== null ? (b as Record<string, unknown>) : { value: b },
      );
    }
    if (typeof message.content === "string") {
      return [{ role: message.role, text: message.content }];
    }
    return [];
  }

  /** System/developer message indexes (openai-completions shape). */
  static systemMessageIndexes(messages: MessageLike[] | undefined): number[] {
    if (!Array.isArray(messages)) return [];
    const indexes: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === "system" || messages[i]?.role === "developer") indexes.push(i);
    }
    return indexes;
  }

  /** Collect every cache_control marker reference in the payload. */
  static collect(payload: unknown): MarkerIndex {
    const index: MarkerIndex = { system: [], tools: [], messages: [] };
    if (!payload || typeof payload !== "object") return index;
    const body = payload as Record<string, unknown>;
    for (const block of Markers.systemBlocks(body)) {
      if (Markers.isCacheControl(block.cache_control)) {
        index.system.push({ region: "system", holder: block, messageIndex: -1, position: -1 });
      }
    }
    const tools = body.tools as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        if (tool && typeof tool === "object" && Markers.isCacheControl(tool.cache_control)) {
          index.tools.push({
            region: "tools",
            holder: tool,
            messageIndex: -1,
            position: -1,
          });
        }
      }
    }
    const messages = body.messages as MessageLike[] | undefined;
    if (Array.isArray(messages)) {
      let position = 0;
      for (let i = 0; i < messages.length; i++) {
        const blocks = Markers.contentBlocks(messages[i]);
        position += blocks.length;
        for (const block of blocks) {
          if (Markers.isCacheControl(block.cache_control)) {
            index.messages.push({
              region: "messages",
              holder: block,
              messageIndex: i,
              position,
            });
          }
        }
      }
    }
    return index;
  }
}
