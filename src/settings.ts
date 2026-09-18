/**
 * pi-cache — settings presenter.
 *
 * One responsibility: render the resolved PI_CACHE_* options in the
 * settings-UI layout pi uses for its own settings — a selectable list
 * where each row shows the option name, a one-line description, and the
 * current value. In non-UI modes it prints the same lines to stderr; it
 * never mutates options (read-only view of resolved state).
 */

import type { PiCacheOptions } from "./constants.ts";

export interface SettingRow {
  id: string;
  title: string;
  description: string;
  value: string;
}

/** Settings-UI item shape used by pi's extension selectors. */
export interface SelectorItem {
  id: string;
  title: string;
  description: string;
}

export class SettingsPresenter {
  /** The feature/tunable rows, in settings-pane order. */
  rows(opts: PiCacheOptions): SettingRow[] {
    const on = (b: boolean): string => (b ? "on" : "off");
    return [
      { id: "telemetry", title: "Telemetry", description: "Record per-request cache usage to the ledger", value: on(opts.telemetry) },
      { id: "sortTools", title: "Sort tools", description: "Deterministic tool order for byte-stable prefixes", value: on(opts.sortTools) },
      { id: "dedupTools", title: "Dedup tools", description: "Drop exact-duplicate tool schemas from the payload", value: on(opts.dedupTools) },
      { id: "affinity", title: "Affinity watch", description: "Observe x-session-id stability (OpenRouter sticky routing)", value: "on" },
      { id: "advisory", title: "Compaction advisory", description: "Note warm-cache compactions that re-write the prefix", value: on(opts.advisory) },
      { id: "autoCompact", title: "Auto-compaction", description: "Compact in cold-window turns (cache already lost) at idle", value: on(opts.autoCompact) },
      { id: "softCompact", title: "Soft compaction", description: "Per-turn compaction that never touches cached segments", value: opts.softCompactMode },
    ];
  }

  /** Present via pi's settings-selector UI when available; else print. */
  present(opts: PiCacheOptions, ui: { select?: unknown } | undefined, mode: string | undefined): void {
    const rows = this.rows(opts);
    if (mode === "tui" && ui && typeof ui.select === "function") {
      const items: SelectorItem[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: `${r.description} — current: ${r.value}`,
      }));
      try {
        (ui.select as (t: string, o: SelectorItem[], _opts?: unknown) => unknown)(
          "pi-cache settings",
          items,
          { showDescription: true },
        );
        return;
      } catch {
        /* fall through to stderr listing */
      }
    }
    for (const r of rows) {
      console.error(`${r.id.padEnd(12)} ${r.description} — current: ${r.value}`);
    }
  }
}