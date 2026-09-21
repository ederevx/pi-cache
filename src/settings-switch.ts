/**
 * pi-cache — settings switch board.
 *
 * One responsibility: own the mapping between a `/cache-settings` row id
 * and the controller that owns that option — reading every live value for
 * the presenter's snapshot and applying and persisting an in-place change
 * so the command handler only routes the chosen row. It owns the switch
 * side effects (flipping the owning controller, keeping auto-compaction's
 * cache-neutral relaxation in sync, saving the owned settings) and returns
 * the notification text. It never touches UI.
 */

import type { CacheLedger } from "./ledger.ts";
import type { PrefixNormalizer } from "./normalizer.ts";
import type { SessionPinner } from "./session-pin.ts";
import type { CompactionAdvisor } from "./compaction.ts";
import type { AutocompactController } from "./autocompact.ts";
import type { FastCompactionController } from "./fastcompact.ts";
import type { UserSettings, UserSettingsStore } from "./user-settings.ts";
import type { LiveSettings } from "./settings.ts";

/** How one row applies its new boolean to its owning controller. */
interface SwitchRoute {
  /** The persisted settings key (also the row id). */
  key: keyof UserSettings;
  /** Human label used in the notification text. */
  label: string;
  apply(enabled: boolean): void;
}

export class SettingsSwitchBoard {
  private readonly routes: Record<string, SwitchRoute>;

  constructor(
    private readonly ledger: CacheLedger,
    private readonly normalizer: PrefixNormalizer,
    private readonly pinner: SessionPinner,
    private readonly advisor: CompactionAdvisor,
    private readonly autocompact: AutocompactController,
    private readonly fast: FastCompactionController,
    private readonly store: UserSettingsStore,
  ) {
    this.routes = {
      telemetry: { key: "telemetry", label: "telemetry", apply: (on) => this.ledger.setEnabled(on) },
      sortTools: { key: "sortTools", label: "sort tools", apply: (on) => this.normalizer.setSortTools(on) },
      dedupTools: { key: "dedupTools", label: "dedup tools", apply: (on) => this.normalizer.setDedupTools(on) },
      pinSession: { key: "pinSession", label: "session pin", apply: (on) => this.pinner.setEnabled(on) },
      advisory: { key: "advisory", label: "advisory", apply: (on) => this.advisor.setEnabled(on) },
      autoCompact: { key: "autoCompact", label: "auto-compaction", apply: (on) => this.autocompact.setEnabled(on) },
      fastCompaction: {
        key: "fastCompaction",
        label: "fast compaction",
        apply: (on) => {
          this.fast.setEnabled(on);
          this.autocompact.setCacheNeutral(on);
        },
      },
      fastBranchSummary: {
        key: "fastBranchSummary",
        label: "fast branch summary",
        apply: (on) => this.fast.setBranchEnabled(on),
      },
    };
  }

  /** Every live option value, for the presenter's two-column view. */
  snapshot(): LiveSettings {
    return {
      telemetry: this.ledger.enabled,
      sortTools: this.normalizer.sortTools,
      dedupTools: this.normalizer.dedupTools,
      pinSession: this.pinner.enabled,
      advisory: this.advisor.enabled,
      autoCompact: this.autocompact.enabled,
      fastCompaction: this.fast.enabled,
      fastBranchSummary: this.fast.branchEnabled,
    };
  }

  /** Apply the row's new value to its owner, persist it, and notify. */
  set(id: string, value: string): string | undefined {
    const route = this.routes[id];
    if (!route) return undefined;
    const enabled = value === "on";
    route.apply(enabled);
    this.store.saveFlag(route.key, enabled);
    return `pi-cache: ${route.label} ${enabled ? "on" : "off"} (saved)`;
  }
}