/**
 * pi-cache — fast-compaction switch board.
 *
 * One responsibility: apply and persist the two fast-compaction switches
 * (the compaction override and the /tree branch summary) so the command
 * handler only routes a row's new value. It owns the switch side effects —
 * flipping the controller flag, keeping auto-compaction's cache-neutral
 * relaxation in sync, and saving the owned settings — and returns the
 * notification text. It never touches UI.
 */

import type { FastCompactionController } from "./fastcompact.ts";
import type { AutocompactController } from "./autocompact.ts";
import type { UserSettingsStore } from "./user-settings.ts";

export class FastSwitchBoard {
  constructor(
    private readonly fast: FastCompactionController,
    private readonly autocompact: AutocompactController,
    private readonly store: UserSettingsStore,
  ) {}

  /** Set the named switch from its "on"/"off" value and notify. */
  set(id: string, value: string): string | undefined {
    if (id === "fastCompaction") return this.setCompaction(value === "on");
    if (id === "fastBranchSummary") return this.setBranchSummary(value === "on");
    return undefined;
  }

  /** The compaction override also relaxes auto-compaction's warm floor. */
  private setCompaction(enabled: boolean): string {
    this.fast.setEnabled(enabled);
    this.autocompact.setCacheNeutral(enabled);
    this.store.save({ fastCompaction: enabled });
    return `pi-cache: fast compaction ${enabled ? "on" : "off"} (saved)`;
  }

  /** The branch-summary switch is independent of auto-compaction. */
  private setBranchSummary(enabled: boolean): string {
    this.fast.setBranchEnabled(enabled);
    this.store.save({ fastBranchSummary: enabled });
    return `pi-cache: fast branch summary ${enabled ? "on" : "off"} (saved)`;
  }
}