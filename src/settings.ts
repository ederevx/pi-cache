/**
 * pi-cache — settings presenter.
 *
 * One responsibility: turn the live option values into ordered rows, then
 * present them in pi's two-column settings layout (padded label | current
 * value, with the selected row's description and hint below) through the
 * extension custom UI. Non-UI modes print the same rows to stderr. Never
 * mutates options and never persists; in-place changes are reported to the
 * caller's callback.
 */

import { CacheSettingsView } from "./settings-view.ts";
import { FeatureSwitch } from "./feature-switch.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface SettingRow {
  id: string;
  title: string;
  description: string;
  value: string;
}

/**
 * Every toggleable option's current value, owned by the controllers and
 * read through `SettingsSwitchBoard.snapshot()`. Every row is editable, so
 * each value is "on" or "off".
 */
export interface LiveSettings {
  telemetry: boolean;
  dedupTools: boolean;
  anchor: boolean;
  retentionOverride: boolean;
  canonicalize: boolean;
  sharedKey: boolean;
  forceWarm: boolean;
  advisory: boolean;
  autoCompact: boolean;
  fastCompaction: boolean;
  fastBranchSummary: boolean;
  fastDigest: boolean;
  missDiagnosis: boolean;
}

/** Reports an in-place value change ("on"/"off") for an editable row. */
export type SettingsChange = (id: string, value: string) => void;

/** The subset of pi's Theme the view styles with. */
export interface ViewTheme {
  fg(color: "accent" | "muted" | "dim" | "border", text: string): string;
}

export class SettingsPresenter {
  /** The /cache-stats miss-taxonomy switch (live via /cache-settings). */
  private readonly missDiagnosis = new FeatureSwitch(true);

  /** The live miss-diagnosis switch (toggled from /cache-settings). */
  get missDiagnosisEnabled(): boolean {
    return this.missDiagnosis.enabled;
  }

  /** Turn the miss-taxonomy line on or off in place. */
  setMissDiagnosisEnabled(enabled: boolean): void {
    this.missDiagnosis.set(enabled);
  }

  /** The option rows, in settings-pane order, from the live snapshot.
   *  Rows whose PI_CACHE_* env var is pinned carry a marker so the user
   *  sees why a toggle would not stick across restarts. */
  rows(live: LiveSettings, pinned: ReadonlySet<string> = new Set()): SettingRow[] {
    const on = (b: boolean): string => (b ? "on" : "off");
    const row = (id: string, title: string, description: string, value: string): SettingRow => ({
      id,
      title: pinned.has(id) ? `${title} (env-pinned)` : title,
      description,
      value,
    });
    return [
      row("telemetry", "Telemetry", "Record per-request cache usage to the ledger", on(live.telemetry)),
      row("dedupTools", "Dedup tools", "Drop exact-duplicate tool schemas from the payload", on(live.dedupTools)),
      row("anchor", "Breakpoint anchor", "Pin a fourth Anthropic breakpoint on stable mid-history", on(live.anchor)),
      row("retentionOverride", "Long retention override", "Rewrite cache markers to the 1h/24h tier per request", on(live.retentionOverride)),
      row("canonicalize", "Canonicalize listings", "Sort skill and AGENTS.md listings in the system prompt", on(live.canonicalize)),
      row("sharedKey", "Shared cache key", "Derive OpenAI prompt_cache_key from the prefix head so siblings share a bucket", on(live.sharedKey)),
      row("forceWarm", "Force warming", "Answer every cache-warming decision with warm when pi's own economics still justify it", on(live.forceWarm)),
      row("missDiagnosis", "Miss diagnosis", "Show the miss taxonomy (cold-start, idle-expiry, replica-flap, partial) in /cache-stats", on(live.missDiagnosis)),
      row("advisory", "Compaction advisory", "Note warm-cache compactions that re-write the prefix", on(live.advisory)),
      row("autoCompact", "Auto-compaction", "Compact in cold-window turns (cache already lost) at idle", on(live.autoCompact)),
      row("fastCompaction", "Fast compaction", "Override pi's summarizer with a byte-stable fast cache-aware compaction", on(live.fastCompaction)),
      row("fastDigest", "Fast digest", "Append a deterministic digest of the dropped span after the fast stub; huge spans fall back to pi's summarizer", on(live.fastDigest)),
      row("fastBranchSummary", "Fast branch summary", "Override /tree branch summarization with a byte-stable stub (lossier than compaction)", on(live.fastBranchSummary)),
    ];
  }

  /**
   * Present the rows in pi's two-column settings view when a TUI custom UI
   * is available, reporting in-place changes through `onChange`; otherwise
   * print the rows and report nothing. Rendering failures fall back to the
   * listing so the command never breaks a session.
   */
  async present(
    live: LiveSettings,
    ui: ExtensionUIContext | undefined,
    mode: string | undefined,
    onChange: SettingsChange,
    pinned: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const rows = this.rows(live, pinned);
    if (mode === "tui" && typeof ui?.custom === "function") {
      try {
        await ui.custom((_tui, theme, _keybindings, done) =>
          new CacheSettingsView(rows, theme, onChange, () => done(undefined)),
        );
        return;
      } catch {
        /* fall through to the stderr listing */
      }
    }
    this.printRows(rows);
  }

  /** Print the same rows to stderr for non-UI modes. */
  private printRows(rows: SettingRow[]): void {
    console.error("pi-cache-settings:\n  " + rows.map((r) => this.formatRow(r)).join("\n  "));
  }

  /** One row in the fallback listing's single-line layout. */
  private formatRow(row: SettingRow): string {
    return `${row.title}: ${row.description} — current: ${row.value}`;
  }
}