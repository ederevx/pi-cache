/**
 * pi-cache — settings switch board.
 *
 * One responsibility: own the mapping between a `/cache-settings` row id
 * and the controller that owns that option — reading every live value for
 * the presenter's snapshot and applying and persisting an in-place change
 * so the command handler only routes the chosen row. It owns the switch
 * side effects (flipping the owning controller, keeping auto-compaction's
 * cache-neutral relaxation in sync, saving the owned settings) and returns
 * the notification text. Rows pinned by a PI_CACHE_* env var are refused
 * (env beats stored settings on every restart, so a toggle would silently
 * lose). It never touches UI.
 */

import type { CacheLedger } from "./ledger.ts";
import type { PrefixNormalizer } from "./normalizer.ts";
import type { BreakpointAnchor } from "./breakpoint-anchor.ts";
import type { RetentionRewriter } from "./retention.ts";
import type { SystemCanonicalizer } from "./canonicalizer.ts";
import type { CacheKeySharer } from "./cache-key.ts";
import type { WarmingPolicy } from "./warming-policy.ts";
import type { CompactionAdvisor } from "./compaction.ts";
import type { AutocompactController } from "./autocompact.ts";
import type { FastCompactionController } from "./fastcompact.ts";
import type { UserSettings, UserSettingsStore } from "./user-settings.ts";
import type { SettingsPresenter, LiveSettings } from "./settings.ts";

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
    private readonly anchor: BreakpointAnchor,
    private readonly retention: RetentionRewriter,
    private readonly canonicalizer: SystemCanonicalizer,
    private readonly cacheKey: CacheKeySharer,
    private readonly warmingPolicy: WarmingPolicy,
    private readonly advisor: CompactionAdvisor,
    private readonly autocompact: AutocompactController,
    private readonly fast: FastCompactionController,
    private readonly stats: SettingsPresenter,
    private readonly store: UserSettingsStore,
    /** Row ids pinned by a PI_CACHE_* env var; toggles are refused. */
    private readonly pinned: ReadonlySet<string> = new Set(),
  ) {
    this.routes = {
      telemetry: { key: "telemetry", label: "telemetry", apply: (on) => this.ledger.setEnabled(on) },
      dedupTools: { key: "dedupTools", label: "dedup tools", apply: (on) => this.normalizer.setDedupTools(on) },
      anchor: { key: "anchor", label: "breakpoint anchor", apply: (on) => this.anchor.setEnabled(on) },
      retentionOverride: {
        key: "retentionOverride",
        label: "long retention override",
        apply: (on) => this.retention.setEnabled(on),
      },
      canonicalize: {
        key: "canonicalize",
        label: "listing canonicalization",
        apply: (on) => this.canonicalizer.setEnabled(on),
      },
      sharedKey: { key: "sharedKey", label: "shared cache key", apply: (on) => this.cacheKey.setEnabled(on) },
      forceWarm: { key: "forceWarm", label: "force warming", apply: (on) => this.warmingPolicy.setEnabled(on) },
      missDiagnosis: {
        key: "missDiagnosis",
        label: "miss diagnosis",
        apply: (on) => this.stats.setMissDiagnosisEnabled(on),
      },
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
      fastDigest: {
        key: "fastDigest",
        label: "fast digest",
        apply: (on) => this.fast.setDigestEnabled(on),
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
      dedupTools: this.normalizer.dedupTools,
      anchor: this.anchor.enabled,
      retentionOverride: this.retention.enabled,
      canonicalize: this.canonicalizer.enabled,
      sharedKey: this.cacheKey.enabled,
      forceWarm: this.warmingPolicy.enabled,
      missDiagnosis: this.stats.missDiagnosisEnabled,
      advisory: this.advisor.enabled,
      autoCompact: this.autocompact.enabled,
      fastCompaction: this.fast.enabled,
      fastDigest: this.fast.digestEnabled,
      fastBranchSummary: this.fast.branchEnabled,
    };
  }

  /** Apply the row's new value to its owner, persist it, and notify. */
  set(id: string, value: string): string | undefined {
    const route = this.routes[id];
    if (!route) return undefined;
    if (this.pinned.has(id)) {
      return `pi-cache: ${route.label} is pinned by its PI_CACHE_* env var`;
    }
    const enabled = value === "on";
    route.apply(enabled);
    this.store.saveFlag(route.key, enabled);
    return `pi-cache: ${route.label} ${enabled ? "on" : "off"} (saved)`;
  }
}