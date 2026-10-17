# pi-cache

Adds cache-aware request transforms, compaction, and cache-usage
telemetry to pi.

## Installation

As a pi package (see `docs/packages.md`):

    pi install git:github.com/ederevx/pi-cache@v0.14.2
    pi -e /absolute/path/to/pi-cache      # try a local checkout for one run

The repo declares its extension in `package.json` under the `pi` key
(`pi.extensions` -> `./src/index.ts`) and lists the bundled pi core
packages as `peerDependencies` and marks them optional in
`peerDependenciesMeta`, so pi's `npm install` in a git clone does not
vendor the host's bundled packages. There is no build step and no
third-party runtime dependency; pi loads `src/*.ts` in place.

As a flat extension copy:

    bash scripts/install.sh

Re-run to refresh owned copies in place (idempotent; the manifest at
`~/.pi/agent/.pi-cache/manifest.json` records exactly what it owns).
Then run `/reload` in pi (or restart). No config file needed.

## How it works

Cache-aware compaction has two layers, both on by default.

- **Compaction pressure.** The auto-compaction trigger is a
  probabilistic *compaction pressure* that blends context degradation as
  the window fills with the expected cost of continuing versus rewriting
  the prefix (cache write amortization, coldness, TTL idle ramp), with a
  warm-cache floor and fast compaction relaxing it. The expected-cost
  horizon shrinks toward cache expiry: the current request always
  counts, and each further request counts only while the cache is still
  warm, so a prefix seconds from its TTL asks for less rewrite than a
  freshly touched one. The read rates come from pi's own model catalog,
  or — for OpenRouter-routed models — from a freshly pulled OpenRouter
  snapshot (see below). It fires at three
  idle points when the pressure draw passes: after a turn settles
  (`agent_settled`), on a session-scoped timer when the provider cache
  TTL expires while pi sits idle (`PI_CACHE_IDLE_TRIGGER`), and when a
  cold prompt arrives before a turn (the `input` handler defers the
  prompt until compaction finishes, `PI_CACHE_BEFORE_TURN`). A fourth,
  mid-run point fires at a turn boundary (`turn_end`) only when the
  pressure is saturated (probability 1) and the window is at least half
  full, so a long agentic run compacts without waiting to settle; it
  proposes a boundary compaction and asks pi to continue the run
  (`PI_CACHE_MIDTERM`, using the fast summary; without fast compaction it
  falls back to the aborting `ctx.compact()`).
  With fast compaction on, the cache-window gate is relaxed because the
  override is prefix-stable; with it off, compaction stays inside
  cold/churned windows.
- **Fast compaction override.** When fast compaction is on, pi-cache
  answers `session_before_compact` for *every* compaction reason
  (`manual`/`threshold`/`overflow`) with a byte-stable cache-aware
  override that replaces pi's LLM summarizer entirely, and answers a
  wanted `/tree` branch summary (`session_before_tree`) the same way.
  Turn it off with the `/cache-settings` switch or
  `PI_CACHE_FAST_COMPACT=off`; branch summaries have their own
  `PI_CACHE_FAST_BRANCH_SUMMARY` switch, and pi's own normal summarizer
  runs for whichever is off. pi-cache also bounds the verbatim window
  pi's cut keeps: when a single recent entry dwarfs pi's keep-recent
  budget (a many-hundred-KB tool result), pi's cut lands before it and
  would keep it in every retry, so pi-cache advances the cut past the
  oversized content (or keeps the summary alone) instead of overflowing
  the provider context. Tune the retained-window multiple with
  `PI_CACHE_FAST_KEEP_RATIO` (default 4).
- **Dropped-span digest.** The fast stub alone discards the summarized
  span's content; with the digest on (default), pi-cache appends a
  deterministic, bounded extractive record after the stub — modified
  and read files (from pi's own `fileOps`), one capped line per turn
  (first user text, bash commands, tool names) — and folds the previous
  compaction's digest blocks in, so the record accumulates across
  repeated compactions instead of vanishing. The digest sits after the
  stub text, so the shared prefix head is byte-identical either way.
  Fast compaction is enforced for dropped spans of any size — no span
  ever falls back to pi's slow LLM summarizer. After the digest (or
  alone when it is empty) the summary carries a deterministic
  transcript pointer naming the session file and the boundary entry id,
  so dropped detail stays recallable on demand with a bounded search
  (`grep -m 5 '<term>' <session-file>`) instead of a whole-file read.
  Disable the digest with the `/cache-settings` switch or
  `PI_CACHE_FAST_DIGEST=off`.
- **Explicit compaction.** The model-callable `cache_compact` tool lets the
  agent deliberately request a compaction — typically when the user asks
  for a complete context switch — after reading a draw-free snapshot of the
  cache state (global lifetime and session scopes, live pressure). The
  request is deferred to the next settled boundary (`agent_settled`), so
  the tool result is delivered and the live run is never aborted. It
  bypasses the automatic policy (enable switch, warm floor, minimum tokens,
  cooldown, and the probability draw) but still honors the in-flight/window
  gate, and one request per run is accepted (duplicate calls coalesce).
  Call `pre_cache` once first: it returns the pi-cache catalog and gates
  `cache_compact`.

The cache TTL that drives the idle trigger and the compaction-pressure
ramp uses pi's `promptCache` tier when the model declares one, else a
provider-aware profile for the model in use (Anthropic 5m/1h, OpenAI
30m, DeepSeek 30m, Gemini 5m, Kimi 5m/1h, GLM ~2m), and only then
`PI_CACHE_TTL_SECONDS` (default 300 s) for an unknown model.

**Live model parameters.** For OpenRouter-routed models, pi-cache pulls
OpenRouter's public model list at session start and when the cached
snapshot goes stale, converts its USD-per-token pricing to the per-
million units the economics model uses, and selects any request-wide
override tier by live token count. The last-good snapshot is persisted
under `.pi-cache/model-params.json` (override with
`PI_CACHE_MODEL_PARAMS`) and is used only when OpenRouter is
inaccessible; non-OpenRouter providers keep pi's own rates. Polling is
edge-cached (about once per 2 minutes has value), one request is
in-flight at a time, and no prompts or session content leave the
machine.

## Request transforms

Cache-favoring request transforms are ON by default; the per-request
long-retention override, shared OpenAI cache key, and forced warming are
opt-in. Disable any feature with its `PI_CACHE_*` env var (see
`src/constants.ts`) or with the `/cache-settings` switch (which
persists to pi-cache's owned
`~/.pi/agent/.pi-cache/settings.json`; a set env var pins its row).
`/cache-settings restore` — or the view's **Restore default
configuration** action — deletes the stored overrides and returns every
option to its built-in default; env-pinned rows keep the env value.

- **Tool dedup** — exact-schema tool dedup; volatile fields (cwd,
  absolute paths) removed from tool definitions.
- **Breakpoint anchor** — a fourth Anthropic `cache_control` marker
  pinned on stable mid-history at a quantum position (bounds tail-churn
  loss and the >20-block walk-back gap).
- **Canonicalization** — skill/project listings in the system prompt
  canonicalized so stable regions stay byte-stable.
- **Retention override** — per-request rewrite upgrading every marker to
  the 1h tier (`PI_CACHE_RETENTION_OVERRIDE`).
- **Shared key** — the OpenAI `prompt_cache_key` derived from the prefix
  head so sibling sessions share a warm bucket (`PI_CACHE_SHARED_KEY`).
- **Force warm** — pi's warming decision kept warm when its own
  economics justify it and a real turn exists (`PI_CACHE_FORCE_WARM`);
  the warming schedule follows the tier the rewrite actually put on the
  wire, idle fires defer past an in-flight refresh, and confirmed
  refreshes land in the ledger as `kind: "warm"` telemetry rows.

## Telemetry

Telemetry goes to the `.pi-cache/ledger.jsonl` dot-dir and survives
reloads. Each usage row also carries the request's cache state as
optional fields (`cacheTtlMs`, `piTtlMs`, `retentionLong`, `warm`,
`msSinceCacheTouch`) plus the ledger-owned `kind` (`"turn"` or
`"warm"`) so tier and warm-vs-miss questions are answerable from the
ledger itself; rows written without them stay schema-compatible.

The ledger keeps the most recent `PI_CACHE_LEDGER_MAX_ROWS` rows
(default 20000; trimmed on load, in-session once a full window of
appends accumulates, and at session shutdown). Rows evicted by that
window are folded into a baseline persisted inside the same file, so
`/cache-stats` reports every request ever recorded (`global (all time)`)
while the file stays bounded; the `session` scope remains the current
session's retained window. A bounded pre-trim backup is captured before
any shrinking rewrite (`PI_CACHE_LEDGER_BACKUPS`, `PI_CACHE_LEDGER_BACKUP_TTL_DAYS`, and
`PI_CACHE_LEDGER_BACKUP_MAX_MB`).
Session stats are rebuilt from the ledger on session start so they
survive reloads, and stale atomic-write temp files are swept at load.

Live views: `/cache-stats` (global and session scopes, with live
compaction pressure) and `/cache-settings`.

## Uninstall

    bash scripts/uninstall.sh

Removes exactly the manifest-owned files, hash-verified against the
manifest so a repurposed path is never deleted. The telemetry ledger,
settings, and bounded backups are left in place;
`bash scripts/uninstall.sh --purge` also removes them plus any stale
temp files.

## Repo layout

- `src/` — extension wiring and implementation modules
- `tests/` — zero-dependency validation + OOP/format lint suite
  (`tests/run.ts`, `tests/oop_lint.py`, per-module tests, the installer
  round-trip, and the mock-pi wiring test)
- `docs/research/` — distilled provider/extension evidence and citations
- `docs/design.md` — full design
- `docs/implementation-reference.md` — pi extension API reference
- `docs/web-solutions.md` — surveyed third-party solutions

Details and citations live under `docs/research/` (`docs/design.md` has the
full design).
