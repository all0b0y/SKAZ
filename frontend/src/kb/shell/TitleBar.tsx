import { Icon, IconButton } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { RecordControls } from '../recording/RecordControls';
import { useLibrary, usePrefs, useServices, useUi } from '../state/context';

/**
 * Window title bar (38px, draggable; 80px left for the macOS traffic lights).
 * Holds the panel toggle, the recording control "Record | Folder ▾" (a capsule while recording —
 * the only place that shows a recording is running) and "+ Material".
 */
export function TitleBar() {
  const { prefs } = useServices();
  const sideOpen = usePrefs((s) => s.sideOpen);
  const ready = useLibrary((s) => s.library?.state === 'ready');
  const setAddOpen = useUi((s) => s.setAddMaterialOpen);
  return (
    <header className="kb-titlebar" data-testid="titlebar">
      <div className="kb-titlebar__group">
        <IconButton
          // Static glyph that shows the state (close ⇤ while open, open ⇥ while hidden); it does not animate.
          icon={sideOpen ? 'sidebarClose' : 'sidebarOpen'}
          label={sideOpen ? 'Hide side panel' : 'Show side panel'}
          aria-pressed={sideOpen}
          aria-controls="kb-side"
          onClick={() => prefs.getState().set({ sideOpen: !sideOpen })}
        />
      </div>
      <div className="kb-titlebar__drag" />
      <div className="kb-titlebar__group">
        <RecordControls />
        <Tooltip text={ready ? 'Add files, links or text' : 'Connect the library first'} describes>
          <button type="button" className="kb-pill" aria-disabled={!ready || undefined} data-testid="add-material"
            aria-haspopup="dialog" onClick={() => { if (ready) setAddOpen(true); }}>
            <Icon name="plus" size={14} />Material
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
