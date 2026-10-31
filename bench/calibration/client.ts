/**
 * pi-cache — calibration continuation clients.
 *
 * One responsibility: send one continuation and report exactly what the
 * provider said. The HTTP client talks to an OpenAI-compatible endpoint
 * and treats a missing cache report as unknown, never as zero. The stub
 * client answers deterministically so the harness itself is testable
 * without a network.
 */

import type { Usage } from "./protocol.ts";
import type { CalMessage } from "./history.ts";

/**
 * The endpoint credential, or a refusal. An empty key would otherwise turn
 * every request into an unauthenticated 401 that reads like a model failure.
 */
export function readApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.PI_CALIBRATION_API_KEY;
  if (key === undefined || key.trim() === "") {
    throw new Error("PI_CALIBRATION_API_KEY is not set; there is no default credential");
  }
  return key;
}

/** A plain chat message as an OpenAI-compatible endpoint expects it. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** One request; every leg gets the same limits. */
export interface CompletionRequest {
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature: number;
}

/** One answer plus the provider's own accounting. */
export interface CompletionResult {
  text: string;
  usage: Usage;
  model: string;
  /** The provider's stop reason, or null when it reported none. */
  finishReason: string | null;
}

/** A continuation client. */
export interface ContinuationClient {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/** Flatten the recorded message shapes into chat messages. */
export function toChatMessages(messages: readonly CalMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const text = message.content.map((part) => part.text).join("\n");
    if (message.role === "assistant") return { role: "assistant", content: text };
    if (message.role === "toolResult") {
      const label = message.isError === true ? "tool error" : `tool ${message.toolName ?? "result"}`;
      return { role: "user", content: `[${label}]\n${text}` };
    }
    return { role: "user", content: text };
  });
}

interface ChatCompletionBody {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
  model?: unknown;
}

/** Reads one usage field, keeping "absent" distinct from zero. */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An OpenAI-compatible chat client with a fixed retry policy. */
export class HttpChatClient implements ContinuationClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    retries: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.retries = options.retries;
  }

  /** Send one continuation; retries are inside the same fixed policy. */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await this.once(request);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async once(request: CompletionRequest): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const body = (await response.json()) as ChatCompletionBody;
      const text = body.choices?.[0]?.message?.content;
      return {
        text: typeof text === "string" ? text : "",
        usage: {
          promptTokens: numberOrNull(body.usage?.prompt_tokens),
          cachedTokens: numberOrNull(body.usage?.prompt_tokens_details?.cached_tokens),
          completionTokens: numberOrNull(body.usage?.completion_tokens),
        },
        model: typeof body.model === "string" ? body.model : this.model,
        finishReason: (() => {
          const reason = body.choices?.[0]?.finish_reason;
          return typeof reason === "string" ? reason : null;
        })(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A deterministic client for tests and dry runs. */
export class StubClient implements ContinuationClient {
  private readonly answer: (request: CompletionRequest) => string;
  private readonly calls: CompletionRequest[] = [];
  private readonly failure: Error | null;

  constructor(answer: (request: CompletionRequest) => string, failure: Error | null = null) {
    this.answer = answer;
    this.failure = failure;
  }

  /** Every request this client was handed, in order. */
  get seen(): readonly CompletionRequest[] {
    return this.calls;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request);
    if (this.failure) throw this.failure;
    return {
      text: this.answer(request),
      usage: { promptTokens: null, cachedTokens: null, completionTokens: null },
      model: "stub",
      finishReason: "stop",
    };
  }
}
