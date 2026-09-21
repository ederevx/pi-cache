/**
 * pi-cache — two-column settings view.
 *
 * One responsibility: render SettingsPresenter rows through pi's own
 * two-column SettingsList (padded label | current value, selected row's
 * description and key hint below) framed by DynamicBorder, and forward
 * keyboard input to the list. Pure presentation: it owns no persistence and
 * reports in-place changes to the caller's callback.
 */

import { Container, SettingsList, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { SettingRow, SettingsChange, ViewTheme } from "./settings.ts";

export class CacheSettingsView extends Container {
  private readonly list: SettingsList;

  constructor(
    rows: readonly SettingRow[],
    theme: ViewTheme,
    onChange: SettingsChange,
    onCancel: () => void,
  ) {
    super();
    const border = (text: string): string => theme.fg("border", text);
    this.list = new SettingsList(
      rows.map((row) => CacheSettingsView.toItem(row)),
      10,
      CacheSettingsView.themeFor(theme),
      (id, value) => onChange(id, value),
      onCancel,
      { enableSearch: true },
    );
    this.addChild(new DynamicBorder(border));
    this.addChild(this.list);
    this.addChild(new DynamicBorder(border));
  }

  /** Forward focus input to the list; the Container base has none. */
  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  /** Move the selection to a row id (programmatic navigation). */
  selectItem(id: string): void {
    this.list.selectItem(id);
  }

  /** One SettingItem: an editable row cycles on/off, others are display-only. */
  private static toItem(row: SettingRow): SettingItem {
    return {
      id: row.id,
      label: row.title,
      description: row.description,
      currentValue: row.value,
      values: row.editable ? ["on", "off"] : undefined,
    };
  }

  /** pi's settings palette, built from the injected theme (jiti-safe). */
  private static themeFor(theme: ViewTheme): SettingsListTheme {
    return {
      label: (text, selected) => (selected ? theme.fg("accent", text) : text),
      value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
      description: (text) => theme.fg("dim", text),
      cursor: theme.fg("accent", "→ "),
      hint: (text) => theme.fg("dim", text),
    };
  }
}