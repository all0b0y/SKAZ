import type { SectionId } from '../components/settings/SettingsPanel';

/**
 * A notice deep inside a pane ("add a Soniox key", "choose a notes model") asks
 * the app to open Settings on the section that fixes it. An event keeps those
 * panes free of a prop threaded through every parent just for this.
 */
export const OPEN_SETTINGS_EVENT = 'skaz-open-settings';

export function openSettings(section: SectionId): void {
  window.dispatchEvent(new CustomEvent<SectionId>(OPEN_SETTINGS_EVENT, { detail: section }));
}
