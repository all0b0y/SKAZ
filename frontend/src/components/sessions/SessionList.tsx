import { useState } from 'react';
import { useStore } from '../../state/store';
import { MediaImportDialog } from '../imports/MediaImportDialog';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { SessionNavigator } from './SessionNavigator';

interface SessionListProps {
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}

export function SessionList({ onOpenSettings, onOpenSearch }: SessionListProps) {
  const recorderState = useStore((s) => s.recorderState);
  const newSession = useStore((s) => s.newSession);

  const [creationError, setCreationError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const imports = useStore((s) => s.imports);
  const selectSession = useStore((s) => s.selectSession);
  const activeImport = Object.values(imports).find((s) => ['queued', 'downloading', 'preparing', 'uploading', 'processing'].includes(s.status));

  const isCapturing =
    recorderState === 'recording' || recorderState === 'paused' || recorderState === 'processing';

  return (
    <section className="rail" aria-label="Sessions">
      <header className="rail__head">
        <h2 className="rail__title">Sessions</h2>
      </header>
      <div className="rail__head-actions">
        <Button
          className="rail__new"
          variant="primary"
          icon="plus"
          onClick={() => { setCreationError(''); void newSession().catch((err: unknown) => setCreationError(err instanceof Error ? err.message : String(err))); }}
          disabled={isCapturing}
          aria-label="New session"
          title={isCapturing ? 'Stop recording to start a new session' : 'New session'}
        >
          New session
        </Button>
        <Button
          variant="quiet"
          icon="upload"
          onClick={() => {
            setCreationError('');
            if (activeImport) { void selectSession(activeImport.session_id); return; }
            if (isCapturing) { setCreationError('Stop recording before importing media.'); return; }
            setImportOpen(true);
          }}
          aria-label="Import audio"
          title="Import media"
        />
      </div>

      {creationError && <p role="alert" className="rail__notice">{creationError}</p>}
      <SessionNavigator />

      <div className="rail__foot">
        <button
          className="rail__foot-btn"
          onClick={onOpenSearch}
          aria-label="Search materials"
          title="Search (⌘K)"
        >
          <Icon name="search" size={16} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
        <button
          className="rail__foot-btn"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
        >
          <Icon name="settings" size={16} />
          <span>Settings</span>
        </button>
      </div>

      {importOpen && (
        <MediaImportDialog
          onClose={() => setImportOpen(false)}
          onOpenExisting={(id) => { setImportOpen(false); void selectSession(id); }}
          onOpenSettings={() => { setImportOpen(false); onOpenSettings(); }}
          onCreated={(created) => {
            setImportOpen(false);
            window.dispatchEvent(new CustomEvent('skaz-import-started', { detail: created }));
          }}
        />
      )}
    </section>
  );
}
