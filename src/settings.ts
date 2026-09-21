/**
 * pi-cache — settings presenter and switch selector.
 *
 * One responsibility: render the resolved options plus the live
 * fast-compaction switches in pi's settings-UI layout and resolve the
 * user's choice back to a row id. pi's extension selector takes PLAIN
 * STRING options (select(title, options: string[], opts?) -> Promise<string|undefined>),
 * so each row is formatted as "title: description — current: value" and
 * matched back by identity. Non-UI modes print the same lines to stderr.
 * Never mutates options; the caller owns persistence.
 */

import type { PiCacheOptions } from "./constants.ts";

export interface SettingRow {
  id: string;
  title: string;
  description: string;
  value: string;
}

/** Live switch values owned by FastCompactionController, not by `opts`. */
export interface LiveSettings {
  fastCompaction: boolean;
  fastBranchSummary: boolean;
}

export class SettingsPresenter {
  /**
   * The feature/tunable rows, in settings-pane order. `live` carries the
   * switch values that FastCompactionController owns at runtime.
   */
  rows(opts: PiCacheOptions, live: LiveSettings): SettingRow[] {
    const on = (b: boolean): string => (b ? "on" : "off");
    return [
      { id: "telemetry", title: "Telemetry", description: "Record per-request cache usage to the ledger", value: on(opts.telemetry) },
      { id: "sortTools", title: "Sort tools", description: "Deterministic tool order for byte-stable prefixes", value: on(opts.sortTools) },
      { id: "dedupTools", title: "Dedup tools", description: "Drop exact-duplicate tool schemas from the payload", value: on(opts.dedupTools) },
      { id: "pinSession", title: "Session pin", description: "Inject a stable provider session id for stateless requests so sibling processes share the provider cache bucket", value: on(opts.pinSession) },
      { id: "advisory", title: "Compaction advisory", description: "Note warm-cache compactions that re-write the prefix", value: on(opts.advisory) },
      { id: "autoCompact", title: "Auto-compaction", description: "Compact in cold-window turns (cache already lost) at idle", value: on(opts.autoCompact) },
      { id: "fastCompaction", title: "Fast compaction", description: "Override pi's summarizer with a byte-stable fast cache-aware compaction", value: on(live.fastCompaction) },
      { id: "fastBranchSummary", title: "Fast branch summary", description: "Override /tree branch summarization with a byte-stable stub (lossier than compaction)", value: on(live.fastBranchSummary) },
    ];
  }

  /**
   * Present via pi's selector UI when available and return the chosen row
   * id; otherwise print the rows and return undefined.
   */
  async choose(
    opts: PiCacheOptions,
    live: LiveSettings,
    ui: { select?: unknown } | undefined,
    mode: string | undefined,
  ): Promise<string | undefined> {
    const rows = this.rows(opts, live);
    const lines = this.formatRows(rows);
    if (mode === "tui" && ui && typeof ui.select === "function") {
      const selected = await this.selectRow(ui, lines);
      return rows.find((r, i) => lines[i] === selected)?.id;
    }
    this.printRows(lines);
    return undefined;
  }

  /** Present pi's selector; undefined when dismissed or on any failure. */
  private async selectRow(
    ui: { select?: unknown },
    lines: string[],
  ): Promise<string | undefined> {
    try {
      const selected = await (ui.select as (t: string, o: string[], _opts?: unknown) => Promise<unknown>)(
        "pi-cache settings",
        lines,
      );
      return typeof selected === "string" ? selected : undefined;
    } catch {
      return undefined;
    }
  }

  /** Print the same rows to stderr for non-UI modes. */
  private printRows(lines: string[]): void {
    console.error("pi-cache-settings:\n  " + lines.join("\n  "));
  }

  /** Formatted strings in pi's settings-row layout for the selector. */
  private formatRows(rows: SettingRow[]): string[] {
    return rows.map((r) => `${r.title}: ${r.description} — current: ${r.value}`);
  }
}
