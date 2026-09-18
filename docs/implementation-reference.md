# pi-cache — Implementation Reference (draft)

Implementation-grade reference for building a pi extension named **pi-cache** whose hooks:
(a) normalize the request prefix, (b) read per-request cache usage, (c) adjust compaction.
All paths verified against pi-coding-agent **v0.85.1** and pi-ai **v0.85.1** on this machine
(2026-09-25 research; read-only inspection; no files written outside `~/tmp/cache-research`).

## 0. Versioned paths

- PI-CODING-AGENT npm root: `$(npm root -g)/@earendil-works/pi-coding-agent` (call this `$PI` below)
- Extension API types: `$PI/dist/core/extensions/types.d.ts`
- Compaction types: `$PI/dist/core/compaction/compaction.d.ts`
- pi-ai root (symlink-resolved): `$PI/node_modules/@earendil-works/pi-ai` (call this `$AI`)
- pi-ai public types: `$AI/dist/types.d.ts`
- API impls: `$AI/dist/api/openai-completions.js`, `$AI/dist/api/anthropic-messages.js` (+ sibling `.d.ts`)
- Extension docs: `$PI/docs/extensions.md` (3024 lines, read fully); compaction: `$PI/docs/compaction.md`; settings: `$PI/docs/settings.md`
- Example used by compaction: `$PI/examples/extensions/custom-compaction.ts`

Import surface: extension entry file imports `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` and
exports `export default function (pi: ExtensionAPI) {}` (sync or async). Loaded via jiti (TS, no build).
Auto-discovery: `~/.pi/agent/extensions/*.ts` and `~/.pi/agent/extensions/*/index.ts` (global);
`.pi/extensions/...` project-local (post-trust). Hot-reload via `/reload`.

## 1. ExtensionAPI core

### 1.1 `on()` signature (types.d.ts:902, 906-943)

```ts
export type ExtensionHandler<E, R = undefined> =
  (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;   // types.d.ts:902
export interface ExtensionAPI {
  on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void; // examples
  // ... one overload per event; full list types.d.ts:906-943
}
```

Semantics:
- Handlers run in extension load order (file order under `extensions/`); multiple extensions may subscribe to one event.
- Return-value semantics are per-event (see per-event `*Result` types below). Mutating the event object (e.g.
  `before_provider_headers` `event.headers`, `tool_call` `event.input`, `context` `event.messages`) is the primary
  modification path; returning a result object replaces/patches for the events that declare one.
- `block` semantics exist only on `tool_call` (`{ block: true, reason?, terminate? }`, types.d.ts:818-830) and
  `project_trust` (`{ trusted: "yes"|"no"|"undecided", remember? }`); the transform semantics used by
  `before_provider_request`/`context`/`message_end`/`before_agent_start` are "return replacement or undefined".

Relevant `on` overloads (types.d.ts:907-943):
- `on("context", ExtensionHandler<ContextEvent, ContextEventResult>)` (:919)
- `on("before_provider_request", ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>)` (:920)
- `on("before_provider_headers", ExtensionHandler<BeforeProviderHeadersEvent>)` (:921) — no result type
- `on("after_provider_response", ExtensionHandler<AfterProviderResponseEvent>)` (:922) — no result type
- `on("before_agent_start", ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>)` (:923)
- `on("turn_end", ExtensionHandler<TurnEndEvent>)` (:930)
- `on("message_end", ExtensionHandler<MessageEndEvent, MessageEndEventResult>)` (:933)
- `on("session_before_compact", ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>)` (:913)

### 1.2 Per-event payload shapes (types.d.ts)

**before_agent_start** (:540-555):
```ts
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;                 // raw user prompt text (after expansion)
  images?: ImageContent[];
  systemPrompt: string;           // chained system prompt as of this handler
  systemPromptOptions: BuildSystemPromptOptions; // {customPrompt?, selectedTools?, toolSnippets?, promptGuidelines?, appendSystemPrompt?, cwd?, contextFiles?, skills?}
}
export interface BeforeAgentStartEventResult {          // :848-855
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">; // injected, persisted, sent to LLM
  systemPrompt?: string;  // replaces turn system prompt; chained across handlers
}
```
Note: `ctx.getSystemPrompt()` reflects chained changes inside this event; later `context`/`before_provider_request`
mutations are NOT reflected by it (extensions.md "getSystemPrompt").

**context** (:515-517, result :814-815):
```ts
export interface ContextEvent { type: "context"; messages: AgentMessage[]; } // deep copy, safe to mutate
export interface ContextEventResult { messages?: AgentMessage[]; }
```

**before_provider_headers** (:522-530): `{ type, headers: ProviderHeaders }`; handlers mutate `event.headers`
in place (string = set/override, `null` = delete); **return value ignored**. Retries reuse headers without re-firing.

**before_provider_request** (:519-521 + :817):
```ts
export interface BeforeProviderRequestEvent { type: "before_provider_request"; payload: unknown; }
export type BeforeProviderRequestEventResult = unknown;   // undefined = keep; any other value REPLACES payload for later handlers + request
```
Payload facts (from pi-ai builders; docs/extensions.md "before_provider_request"):
- It is the **provider-serialized body**, not the session `AgentMessage[]`. For `openai-completions` it is
  `{ model, messages, stream, prompt_cache_key?, prompt_cache_retention?, stream_options?, store?, ... }`
  (`openai-completions.js:585-601`); system is an ordinary `{role:"system"}` message in `messages`.
  For `anthropic-messages` it is `{ model, messages, max_tokens, stream, system?, betas?, tools?, ... }`
  (`anthropic-messages.js:795-803`); `system` is an **array** of content blocks
  (`params.system = [{type:"text", text, cache_control?}]`, lines 803-825) and `tools` (with optional
  `cache_control` on the last one) is present when tools are configured (:1129-1134).
- Model and provider do NOT live in the payload: `payload.model` is the model **id string**; the resolved
  model object is `ctx.model` and the provider is `ctx.modelRegistry`/`session`. Use `ctx.model.provider`,
  `ctx.model.id`, `ctx.model.api` for routing decisions; match payload.model to `ctx.model.id`.
- Replacement: `return { ...event.payload, ... }` (non-undefined replaces). Useful for prefix work only if you
  rewrite provider blocks; token counts are not available here (see §6).

**after_provider_response** (:532-536): `{ type, status: number, headers: Record<string,string> }`, before stream
consume; return ignored; headers may be empty on abstracted transports.

**turn_end** (:580-587): `{ type, turnIndex: number, timestamp: number, message: AgentMessage, toolResults: ToolResultMessage[] }`.

**message_end** (:602-607, result :841-845):
```ts
export interface MessageEndEvent { type: "message_end"; message: AgentMessage; }
export interface MessageEndEventResult { message?: AgentMessage; } // replacement must keep same role
```
The assistant `message.usage` is a full `Usage` (see §3.1): when `event.message.role === "assistant"` and
`event.message.usage`, the fields `input/output/cacheRead/cacheWrite/cacheWrite1h?/reasoning?/totalTokens/cost{...}`
are readable directly; the conventional override point for cache-ledgering is
`return { message: { ...event.message, usage: { ...event.message.usage, ... } } }` (pattern shown in extensions.md
"message_end"). The same `Usage` is also visible from inside `tool_result` (`event.usage`, optional, types.d.ts:732)
and replayed by `ctx.getContextUsage()`.

Other events (for completeness): session_start/reload/new/resume/fork (:414-424), session_before_switch (:427-432),
session_before_fork (:435-439), session_before_tree (:463-475), session_shutdown (:477-486), agent_start/end/settled,
ui_prompt_start/end, turn_start (:576-578), message_start/update, tool_execution_* (:609-636), model_select (:639-644),
thinking_level_select, user_bash, input, tool_call (:645-), tool_result (:726-).

## 2. Registration & UI API (types.d.ts)

```ts
registerTool<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams,TDetails,TState>): void;   // :943; def :342-378
registerCommand(name: string, options: Omit<RegisteredCommand,"name"|"sourceInfo">): void;                     // :950; RegisteredCommand :893-900
registerShortcut(shortcut: KeyId, options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }): void; // :955
registerFlag(name: string, options: { description?; type: "boolean"; default?: boolean } | { description?; type: "string"; default?: string }): void; // :960
getFlag(name: string): boolean | string | undefined;                                                           // :965
sendMessage<T>(message: Pick<CustomMessage<T>,"customType"|"content"|"display"|"details">,
               options?: { triggerTurn?: boolean; deliverAs?: "steer"|"followUp"|"nextTurn" }): void;          // :976
sendUserMessage(content: string | (TextContent|ImageContent)[], options?): Promise<void>;                      // :982
appendEntry<T>(customType: string, data?: T): void;                                                             // :990
exec(command, args, options?): Promise<ExecResult>; setSessionName/getSessionName/setLabel;                    // :991-999
getActiveTools(): string[]; getAllTools(): ToolInfo[]; setActiveTools(names: string[]): void; getCommands();   // :1000-1008
setModel(model): Promise<boolean>; getThinkingLevel/setThinkingLevel; events ({on,emit}); registerProvider;    // :1009+
registerMessageRenderer(customType, renderer); registerMarkdownTransformer(fn); registerEntryRenderer(customType, renderer);
```
- `sendUserMessage(content, { deliverAs?: "steer"|"followUp"; expandPromptTemplates?: boolean })` — plain string or
  text/image content array (types.d.ts:270-280 region).
- Tool result may carry `usage?: Usage` for nested LLM calls (docs "Usage accounting": persisted, included in
  footer/`/session`/RPC totals; `tool_result` can inspect/replace).
- Status/footer/widget (ctx.ui, types.d.ts:80-104): `setStatus(key: string, text: string | undefined): void`;
  `setWidget(key, content: string[] | undefined, options?: { placement: "belowEditor" })` or component factory;
  `setFooter(factory | undefined)`; `setTitle`; `setWorkingMessage/setWorkingVisible/setWorkingIndicator`;
  `addAutocompleteProvider`. Guard with `ctx.hasUI` (false in print/json modes; notify/setStatus/setWidget are
  fire-and-forget and work in TUI+RPC).
- Command handler ctx is `ExtensionCommandContext` (extends ExtensionContext with `getSystemPromptOptions()`,
  `waitForIdle()`, `newSession({parentSession, setup, withSession})`, `fork(entryId,{position,withSession})`,
  `navigateTree(...)`, `switchSession(...)`, `reload()`, `sendMessage/sendUserMessage` on `ReplacedSessionContext`).
- Lifecycle guards: start background resources in `session_start`, tear down in `session_shutdown`; use `ctx.signal`
  for abort-aware nested work.

## 3. Usage type & per-request cache usage

### 3.1 `Usage` (pi-ai types.d.ts:263-288)
```ts
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;      // subset of cacheWrite; Anthropic-only split (ephemeral_1h)
  reasoning?: number;         // subset of output; provider-dependent
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```
Reading it in an extension: `message_end` `event.message.usage`
(`event.message.role === "assistant"`), `tool_result` `event.usage`, `ctx.getContextUsage()` (returns
`ContextUsage { tokens?: number|null; contextWindow: number; percent?: number|null }`, types.d.ts:193-197; uses last
assistant usage + heuristic estimate of trailing messages), or walk `ctx.sessionManager.getEntries()` +
`getLastAssistantUsage` (compaction.d.ts:57-59) for history.

### 3.2 Where cache numbers come from (pi-ai)
- **openai-completions** `parseChunkUsage(rawUsage, model)` (`openai-completions.js:1177-1210`):
  `cacheRead = prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens ?? 0`;
  `cacheWrite = prompt_tokens_details.cache_write_tokens || 0`;
  `input = max(0, prompt_tokens - cacheRead - cacheWrite)`; `reasoning = completion_tokens_details.reasoning_tokens`;
  `totalTokens = input + output + cacheRead + cacheWrite`; then `calculateCost(model, usage)`. Covers OpenAI,
  OpenRouter, DeepSeek, Kimi placements (comment at 1182-1191).
- **anthropic-messages** (`anthropic-messages.js:407-418`): from `message_start` usage:
  `cacheRead = cache_read_input_tokens`, `cacheWrite = cache_creation_input_tokens`,
  `cacheWrite1h = cache_creation.ephemeral_1h_input_tokens`, `totalTokens = input+output+cacheRead+cacheWrite`
  (Anthropic reports no total). Also `cacheWrite1h` column at :413.
- **google-* / openai-responses** parse analogous raw fields (not inspected in depth here; the cross-provider
  contract is the `Usage` shape above).

## 4. pi-ai cache-related internals (file:line)

### 4.1 Retention & cache_control (anthropic-messages.js)
```js
// :17-26  resolveCacheRetention: default "short"; PI_CACHE_RETENTION=long elects long
function resolveCacheRetention(cacheRetention, env) {
    if (cacheRetention) return cacheRetention;
    if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") return "long";
    return "short";
}
// :28-40  getCacheControl → { retention, cacheControl: { type:"ephemeral", ttl? } } ; ttl="1h" when long && supportsLongCacheRetention
// :123    compat default: supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true
// :414-417 usage split fields (see 3.2)
// :725-729 x-session-affinity: sessionId header only when compat.sendSessionAffinityHeaders (default false, :124)
```
Injection points (all gated by the same `cacheControl` object):
- System prompt blocks: OAuth identity + system prompt `:800-825` (`params.system = [{type:"text", text, cache_control?}, ...]`);
- Conversation history: last user message `:1066-1088` — last content block (text|image|tool_result) gets
  `cache_control`, or string content is rewritten to a block with `cache_control`;
- Tool schema: last tool definition `:1133` `...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {})`.
- `retention === "none"` disables all block injection (:34-36 under getCacheControl guard; openai :808).

### 4.2 openai-completions.js
```js
// :158-165 resolveCacheRetention (same PI_CACHE_RETENTION handling)
// :556-570 session affinity: compat.sendSessionAffinityHeaders (default false, :1313-1314) then
//          sessionAffinityFormat==="openrouter" → header "x-session-id"=sessionId
//          else sessionAffinityFormat==="openai" → headers session_id, "x-client-request-id", "x-session-affinity"
// :585-601 buildParams: prompt_cache_key (when baseUrl openai.com or (long && supportsLongCacheRetention),
//          clamped via clampOpenAIPromptCacheKey(sessionId)); prompt_cache_retention: long&&supports… ? "24h" : undefined
// :808-811 getCompatCacheControl block gating + ttl "1h" for openai cache_control when long
// :1177-1210 parseChunkUsage (see 3.2)
// :1245 isOpenRouter = provider==="openrouter" || baseUrl includes "openrouter.ai"
// :1276 cacheControlFormat auto-detect: provider==="openrouter" && model.id.startsWith("anthropic/") → "anthropic"
// :1311-1314 detectCompat: sessionAffinityFormat = isOpenRouter ? "openrouter" : "openai",
//          supportsLongCacheRetention = !(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway || isNvidia || isAntLing)
// :1345-1360 getCompat(model): every compat field = model.compat.x ?? detected.x (payload/header-level override point)
```
So an anthropic model routed through OpenRouter gets `system` blocks with `cache_control` (since the endpoint
needs Anthropic wire format — see :1276/1279-1296 handling), while OpenRouter's `x-session-id` affinity header is
used at :558-559. Long-retention "24h" is only sent when `compat.supportsLongCacheRetention` (defaults safely).

### 4.3 Compaction settings source of truth
`settings.json` at `~/.pi/agent/settings.json` (+ `.pi/settings.json` project layer) → `compaction: { enabled,
reserveTokens, keepRecentTokens }` (settings.md:114-124; defaults 16384/20000; current machine:
reserveTokens 16384, keepRecentTokens 20000). `CompactionPreparation.settings: CompactionSettings`
(compaction.d.ts:116-129). `PI_CACHE_RETENTION` is a **provider env var** read via `getProviderEnvValue`
($AI/dist/utils/provider-env.js, imported at anthropic-messages.js:9 and openai-completions.js — provider-scoped
env resolution; set it in provider config/env, not the agent settings). Related built-in setting:
`showCacheMissNotices` (settings.md:35, default false) — transcript notices for significant prompt-cache misses
and for compaction/branch-summary usage; pi-cache can complement or replace this via the (b) hook.

### 4.4 Extension config conventions
- No first-class per-extension config store in the runner; conventional patterns:
  - `~/.pi/agent/settings.json` (global) / `.pi/settings.json` (project): a key for your extension
    (`"piCache": {...}`) or reuse of `extensions: [paths]` for loading (settings.md:279-312);
  - state file under `CONFIG_DIR_NAME` (imported from pi-coding-agent; `ctx.cwd` + `join` for project scope,
    `getAgentDir()` for the global `~/.pi/agent` dir — both exported, used by `~/.pi/agent/extensions/a local extension`),
    e.g. `settings.json` next to extension or `~/.pi/agent/pi-cache.json`;
  - `pi.appendEntry(customType, data)` for per-session persisted state (survives restart, not sent to LLM);
  - `pi.registerFlag("pi-cache-...", {type:"boolean"|"string"})` for CLI override;
  - env: `PI_CACHE_RETENTION` (checked by pi-ai itself; docs/extensions.md + settings.md). Check
    `ctx.isProjectTrusted()` before honoring project-local config.
- Local style precedents: `~/.pi/agent/extensions/history.ts` (module doc comment header + pure logic),
  `a local extension.ts` (mapped `before_agent_start`/`tool_call`/`session_before_compact`), and
  `a local extension/enforcer.ts:403-415` (`pi.on("before_agent_start"…)`, `pi.on("tool_call"…)`, `pi.on("tool_result"…)`,
  `pi.on("turn_end"…)`; commands via `pi.registerCommand("subagents",…)` at index.ts:319).

## 5. Compaction: session_before_compact

Event (`types.d.ts:441-450`):
```ts
export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  branchEntries: SessionEntry[];
  customInstructions?: string;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;          // overflow recovery: aborted turn retried after compaction
  signal: AbortSignal;
}
```
`CompactionPreparation` (`compaction.d.ts:116-128`) — NOTE: field names are the flat ones used by the example,
with `messagesToSummarize`/`turnPrefixMessages` split:
```ts
export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];  // will be summarized and discarded
  turnPrefixMessages: AgentMessage[];   // become turn-prefix summary when splitting mid-turn
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;             // summary from previous compaction (iterative updates)
  fileOps: FileOperations;
  settings: CompactionSettings;         // {enabled, reserveTokens, keepRecentTokens}
}
```
Result (`types.d.ts:857-859` + `compaction.d.ts:17-29`):
```ts
export interface SessionBeforeCompactResult { cancel?: boolean; compaction?: CompactionResult; }
export interface CompactionResult<T = unknown> {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  usage?: Usage;                        // from the summarizer LLM call; folded into session totals
  details?: T;
}
```
Return contract: `{ cancel: true }` aborts; `{ compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId,
tokensBefore: preparation.tokensBefore, usage } }` provides a custom proposal (SessionManager sets uuid/parentUuid);
returning undefined falls back to built-in compaction. `session_compact` fires afterwards with
`{ compactionEntry, fromExtension, reason, willRetry }`; `session_compact_failed` with
`{ reason, errorMessage?, aborted, willRetry, fromExtension }` (:452-474).
Reference implementation: `examples/extensions/custom-compaction.ts` — destructures `{ messagesToSummarize,
turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary }`, calls
`ctx.modelRegistry.complete(model, {messages}, { maxTokens, signal, cacheRetention: "none", sessionId: uuidv7() })`
(note: it passes `cacheRetention: "none"` to avoid polluting the summarizer with conversation cache), collapses
text content and returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage: response.usage } }`.
Other call sites: `ctx.compact({ customInstructions, onComplete, onError })`; `compact(...)`/`prepareCompaction(...)`
pure functions in compaction.d.ts:131-156 (session id forwarded without enabling prompt caching per the
`compact()` doc comment).

## 6. Gaps an extension cannot cover + workarounds (pi-cache design notes)

1. **Exact token counts at `before_provider_request`.** The payload (`payload: unknown`) is already provider-
   serialized and contains no token accounting; pi-ai computes usage only from the *response* (`parseChunkUsage` /
   `message_start`). Workarounds: (a) last-known usage from `message_end`/`ctx.getContextUsage()`;
   (b) `estimateTokens` chars/4 heuristic (compaction.d.ts:94-97, exported? — imported from compaction utils;
   conservative overestimate); (c) `session_before_compact` `preparation.tokensBefore` for pre-request context size.
2. **No single event carries both the outgoing payload and incoming usage** (payload: `before_provider_request` /
   `after_provider_response`; usage: `message_end`/`turn_end`). Workaround: correlate by `turnIndex`
   (`turn_start`/`turn_end` events) or by request order; keep a per-turn map in the extension closure
   (extension state is scoped to the process; rebuild persistence/derived state in `session_start`).
3. **`before_provider_headers` is mutation-only** (return ignored) — header policies must mutate `event.headers`
   (string or `null`) and the same headers are reused on retries without re-firing.
4. **`context` messages are a deep copy** and the hook cannot touch the system prompt or provider headers; system
   prompt changes must go through `before_agent_start.systemPrompt`.
5. **`message_end` replacement must keep the same role**, so you cannot inject new messages there; use
   `before_agent_start.message`, `sendMessage`, or an injected tool result instead.
6. **Compaction summarizer calls bypass provider prefix** only if you pass `cacheRetention: "none"` and a fresh
   `sessionId` (pattern in custom-compaction.ts); the built-in `compact()` doc comment also supports routing a
   session id "without enabling prompt caching". Prefix-changing hooks therefore need to know whether a call is a
   summarizer (no hook exists for summarizer calls — guard by checking `ctx.model` vs summarizer model or by
   wrapping via `before_provider_request` on the fingerprint of the compaction prompt).

## 7. Suggested pi-cache hook map (implementation sketch)

- (a) **Normalize request prefix** → `before_provider_request` (return replacement payload after adjusting the
  leading system/messages prefix, e.g. strip/reorder `cache_control`-bearing lead blocks for
  `anthropic-messages` `params.system[0]` or `messages[0]` role=system text; keep `ctx.getSystemPrompt()`
  untouched and document that payload edits don't reflect there).
- (b) **Per-request cache usage** → `message_end` (assistant) reading `message.usage.cacheRead/cacheWrite/...`;
  tie to payload via replay; expose a `/pi-cache` command + `ctx.ui.setStatus("pi-cache", …)` + `appendEntry`
  ledger; optionally `tool_result.event.usage` for nested summarizer costs.
- (c) **Adjust compaction** → `session_before_compact`: read `preparation.{messagesToSummarize, tokensBefore,
  previousSummary}`, decide per `reason`, return `{ compaction: {...} }` or `{ cancel }`; track `session_compact`
  / `session_compact_failed`.
- Config: `~/.pi/agent/pi-cache.json` (via `getAgentDir()`) + `registerFlag`s; honor `ctx.isProjectTrusted()`;
  read `PI_CACHE_RETENTION` yourself if you mirror pi-ai's default but otherwise let pi-ai own it
  (openai-completions.js:158-165, anthropic-messages.js:17-26).

## 8. Unverified / follow-ups for the implementer

- Exact `BuildSystemPromptOptions` member types (used structurally only; see extensions.md commentary + types.d.ts).
- Anthropic payload's full `params` (tools/deferred), `openai-responses`/google cache field mapping details.
- `getProviderEnvValue` provider-scoped env resolution (utils/provider-env.js) — cite before relying on env overrides.
- Whether `context` fires per summarizer call (likely yes — compaction uses the same context pipeline); verify
  before keying (b) on it.