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

Cache-aware compaction has two layers, both on by default; the full trigger
and retention semantics are in `docs/design.md`.

- **Compaction pressure.** Auto-compaction fires on a probabilistic pressure
  that blends context degradation with the expected cost of continuing
  versus rewriting the prefix, checked at settle, at cache-TTL idle, before
  a cold turn, and at a saturated turn boundary.
- **Fast compaction override.** When on, pi-cache answers every compaction
  reason, and a wanted `/tree` branch summary, with a byte-stable
  cache-aware override instead of pi's LLM summarizer.
- **Dropped-span digest.** The override appends a bounded extractive record
  of the summarized span (changed and read files, one line per turn) that
  folds earlier digests in, plus a transcript pointer for bounded recall.
- **Explicit compaction.** `cache_compact` requests a compaction for the next
  settled boundary; call `pre_cache` once first.

The cache TTL that drives the idle trigger and the pressure ramp uses pi's
`promptCache` tier when the model declares one, else a provider-aware
profile (Anthropic 5m/1h, [OI] 30m, DeepSeek 30m, Gemini 5m, Kimi 5m/1h,
GLM ~2m), and only then `PI_CACHE_TTL_SECONDS` (default 300 s) for an
unknown model. The profile table is configuration, not code:
`PI_CACHE_TTL_PROFILES` takes `match[,match...]=short[,long]` entries
separated by `;` (a match is a case-insensitive substring of
`provider modelId`; an omitted long lifetime reuses the short one) and
replaces the table whole, so a provider whose lifetime changes is
corrected without a release. An empty value disables the table; a
malformed entry keeps the default.

**Live model parameters.** For models served from the priced origin,
pi-cache pulls the model list at session start and when the cached
snapshot goes stale, converts its USD-per-token pricing to the per-
million units the economics model uses, and selects any request-wide
override tier by live token count. The endpoint is
`PI_CACHE_MODEL_PARAMS_URL` (default OpenRouter's public model list) and
its decoder is that list's schema; applicability is the model's own
`baseUrl` origin, so no provider name decides it and a regional or
proxied endpoint works by pointing the knob at it. Models from any other
origin keep pi's own rates. The last-good snapshot is persisted under
`.pi-cache/model-params.json` (override with `PI_CACHE_MODEL_PARAMS`),
tagged with the endpoint that produced it so a changed endpoint never
applies another service's prices, and is used only when the endpoint is
inaccessible. `PI_CACHE_MODEL_PARAMS_MAX_AGE_MS`, `_RETRY_MS`,
`_TIMEOUT_MS`, and `_MAX_MODELS` tune the poll. Polling is edge-cached
(about once per 2 minutes has value), one request is in-flight at a
time, and no prompts or session content leave the machine.

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
