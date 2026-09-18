/**
 * pi-cache — settings presenter.
 *
 * One responsibility: render the resolved PI_CACHE_* options in pi's
 * settings-UI layout. pi's extension selector takes PLAIN STRING options
 * (select(title, options: string[], opts?) -> Promise<string|undefined>),
 * so each row is formatted as "title — description (current: value)".
 * Fire-and-forget with a rejection guard; non-UI modes print the same
 * lines to stderr. Never mutates options (read-only view).
 */

import type { PiCacheOptions } from "./constants.ts";

export interface SettingRow {
  id: string;
  title: string;
  description: string;
  value: string;
}

/** Formatted strings in pi's settings-row layout for the selector. */
function formatRows(rows: SettingRow[]): string[] {
  return rows.map((r) => `${r.description} — current: ${r.value}`);
}

export class SettingsPresenter {
  /** The feature/tunable rows, in settings-pane order. */
  rows(opts: PiCacheOptions): SettingRow[] {
    const on = (b: boolean): string => (b ? "on" : "off");
    return [
      { id: "telemetry", title: "Telemetry", description: "Record per-request cache usage to the ledger", value: on(opts.telemetry) },
      { id: "sortTools", title: "Sort tools", description: "Deterministic tool order for byte-stable prefixes", value: on(opts.sortTools) },
      { id: "dedupTools", title: "Dedup tools", description: "Drop exact-duplicate tool schemas from the payload", value: on(opts.dedupTools) },
      { id: "advisory", title: "Compaction advisory", description: "Note warm-cache compactions that re-write the prefix", value: on(opts.advisory) },
      { id: "autoCompact", title: "Auto-compaction", description: "Compact in cold-window turns (cache already lost) at idle", value: on(opts.autoCompact) },
      { id: "softCompact", title: "Soft compaction", description: "Cadence: auto (default) = fast stub compaction whenever live context crosses the threshold again (repeated, input stays bounded); off = disable (arms the cold-window auto-compact fallback)", value: opts.softCompactMode },
      { id: "softMinTokens", title: "Min context", description: "Re-compact when live context reaches this since the last soft compaction (approx. pi keepRecentTokens); 0 = every settle", value: String(opts.softMinTokens) },
      { id: "compactCapture", title: "Compact capture", description: "Persist fast-compacted entries to ~/tmp/pi-cache/compacts (LATEST) for the agent to inspect", value: on(opts.compactCapture) },
    ];
  }

  /** Present via pi's selector UI when available; else print the rows. */
  present(opts: PiCacheOptions, ui: { select?: unknown } | undefined, mode: string | undefined): void {
    const rows = this.rows(opts);
    const lines = formatRows(rows);
    if (mode === "tui" && ui && typeof ui.select === "function") {
      try {
        const promise = (ui.select as (t: string, o: string[], _opts?: unknown) => Promise<unknown>)(
          "pi-cache settings",
          lines,
        );
        void Promise.resolve(promise).catch(() => {
          console.error("pi-cache-settings:\n  " + lines.join("\n  "));
        });
        return;
      } catch {
        /* fall through to stderr listing */
      }
    }
    console.error("pi-cache-settings:\n  " + lines.join("\n  "));
  }
}