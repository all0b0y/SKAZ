import { Icon, IconButton } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { useLibrary, usePrefs, useServices } from '../state/context';

/**
 * Window title bar (38px, draggable; 80px left for the macOS traffic lights).
 * Holds the panel toggle, the place of the recording capsule "Record | Folder ▾" and "+ Material".
 * Recording and adding materials arrive with U3: both are visibly inactive with a reason.
 */
export function TitleBar() {
  const { prefs } = useServices();
  const sideOpen = usePrefs((s) => s.sideOpen);
  const folders = useLibrary((s) => s.folders);
  const inbox = folders.find((f) => f.system)?.name ?? 'Inbox';
  return (
    <header className="kb-titlebar" data-testid="titlebar">
      <div className="kb-titlebar__group">
        <IconButton
          icon="sidebar"
          label={sideOpen ? 'Hide side panel' : 'Show side panel'}
          aria-pressed={sideOpen}
          aria-controls="kb-side"
          onClick={() => prefs.getState().set({ sideOpen: !sideOpen })}
        />
      </div>
      <div className="kb-titlebar__drag" />
      <div className="kb-titlebar__group">
        <Tooltip text="Recording isn’t connected yet" describes>
          <button type="button" className="kb-capsule" aria-disabled="true" data-testid="record-capsule"
            onClick={(event) => event.preventDefault()}>
            <span className="kb-capsule__main"><Icon name="mic" size={14} />Record</span>
            <span className="kb-capsule__div" aria-hidden="true" />
            <span className="kb-capsule__folder">{inbox}<Icon name="chevronDown" size={12} /></span>
          </button>
        </Tooltip>
        <Tooltip text="Adding materials isn’t connected yet" describes>
          <button type="button" className="kb-pill" aria-disabled="true" data-testid="add-material"
            onClick={(event) => event.preventDefault()}>
            <Icon name="plus" size={14} />Material
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
