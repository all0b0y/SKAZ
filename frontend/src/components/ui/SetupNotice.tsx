import { Icon } from './Icon';
import { openSettings } from '../../lib/openSettings';
import type { SectionId } from '../settings/SettingsPanel';

/**
 * A missing setting that blocks an action, stated with the one control that
 * fixes it. A warning the user cannot act on is worse than none.
 */
export function SetupNotice({ message, section }: { message: string; section: SectionId }) {
  return (
    <div className="setup-notice" role="status">
      <Icon name="warning" size={15} className="setup-notice__icon" />
      <span className="setup-notice__text">{message}</span>
      <button type="button" className="btn btn--ghost setup-notice__action" onClick={() => openSettings(section)}>
        Open settings
      </button>
    </div>
  );
}
