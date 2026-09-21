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
  sortTools: boolean;
  dedupTools: boolean;
  pinSession: boolean;
  advisory: boolean;
  autoCompact: boolean;
  fastCompaction: boolean;
  fastBranchSummary: boolean;
}

/** Reports an in-place value change ("on"/"off") for an editable row. */
export type SettingsChange = (id: string, value: string) => void;

/** The subset of pi's Theme the view styles with. */
export interface ViewTheme {
  fg(color: "accent" | "muted" | "dim" | "border", text: string): string;
}

export class SettingsPresenter {
  /** The option rows, in settings-pane order, from the live snapshot. */
  rows(live: LiveSettings): SettingRow[] {
    const on = (b: boolean): string => (b ? "on" : "off");
    return [
      { id: "telemetry", title: "Telemetry", description: "Record per-request cache usage to the ledger", value: on(live.telemetry) },
      { id: "sortTools", title: "Sort tools", description: "Deterministic tool order for byte-stable prefixes", value: on(live.sortTools) },
      { id: "dedupTools", title: "Dedup tools", description: "Drop exact-duplicate tool schemas from the payload", value: on(live.dedupTools) },
      { id: "pinSession", title: "Session pin", description: "Inject a stable provider session id for stateless requests so sibling processes share the provider cache bucket", value: on(live.pinSession) },
      { id: "advisory", title: "Compaction advisory", description: "Note warm-cache compactions that re-write the prefix", value: on(live.advisory) },
      { id: "autoCompact", title: "Auto-compaction", description: "Compact in cold-window turns (cache already lost) at idle", value: on(live.autoCompact) },
      { id: "fastCompaction", title: "Fast compaction", description: "Override pi's summarizer with a byte-stable fast cache-aware compaction", value: on(live.fastCompaction) },
      { id: "fastBranchSummary", title: "Fast branch summary", description: "Override /tree branch summarization with a byte-stable stub (lossier than compaction)", value: on(live.fastBranchSummary) },
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
  ): Promise<void> {
    const rows = this.rows(live);
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