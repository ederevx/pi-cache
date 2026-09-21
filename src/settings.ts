/**
 * pi-cache — settings presenter.
 *
 * One responsibility: turn the resolved options plus the live
 * fast-compaction switches into ordered rows, then present them in pi's
 * two-column settings layout (padded label | current value, with the
 * selected row's description and hint below) through the extension custom
 * UI. Non-UI modes print the same rows to stderr. Never mutates options and
 * never persists; in-place changes are reported to the caller's callback.
 */

import { CacheSettingsView } from "./settings-view.ts";
import type { PiCacheOptions } from "./constants.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface SettingRow {
  id: string;
  title: string;
  description: string;
  value: string;
  /** True when the row's value can be changed in place. */
  editable: boolean;
}

/** Live switch values owned by FastCompactionController, not by `opts`. */
export interface LiveSettings {
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
  /**
   * The feature/tunable rows, in settings-pane order. `live` carries the
   * switch values that FastCompactionController owns at runtime; only those
   * two rows are editable, the rest resolve from env/defaults at load.
   */
  rows(opts: PiCacheOptions, live: LiveSettings): SettingRow[] {
    const on = (b: boolean): string => (b ? "on" : "off");
    return [
      { id: "telemetry", title: "Telemetry", description: "Record per-request cache usage to the ledger", value: on(opts.telemetry), editable: false },
      { id: "sortTools", title: "Sort tools", description: "Deterministic tool order for byte-stable prefixes", value: on(opts.sortTools), editable: false },
      { id: "dedupTools", title: "Dedup tools", description: "Drop exact-duplicate tool schemas from the payload", value: on(opts.dedupTools), editable: false },
      { id: "pinSession", title: "Session pin", description: "Inject a stable provider session id for stateless requests so sibling processes share the provider cache bucket", value: on(opts.pinSession), editable: false },
      { id: "advisory", title: "Compaction advisory", description: "Note warm-cache compactions that re-write the prefix", value: on(opts.advisory), editable: false },
      { id: "autoCompact", title: "Auto-compaction", description: "Compact in cold-window turns (cache already lost) at idle", value: on(opts.autoCompact), editable: false },
      { id: "fastCompaction", title: "Fast compaction", description: "Override pi's summarizer with a byte-stable fast cache-aware compaction", value: on(live.fastCompaction), editable: true },
      { id: "fastBranchSummary", title: "Fast branch summary", description: "Override /tree branch summarization with a byte-stable stub (lossier than compaction)", value: on(live.fastBranchSummary), editable: true },
    ];
  }

  /**
   * Present the rows in pi's two-column settings view when a TUI custom UI
   * is available, reporting in-place changes through `onChange`; otherwise
   * print the rows and report nothing. Rendering failures fall back to the
   * listing so the command never breaks a session.
   */
  async present(
    opts: PiCacheOptions,
    live: LiveSettings,
    ui: ExtensionUIContext | undefined,
    mode: string | undefined,
    onChange: SettingsChange,
  ): Promise<void> {
    const rows = this.rows(opts, live);
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