import { useState } from 'react';
import { useStore } from '../../state/store';
import type { AudioFileChoice } from '../../api/bridge';
import { ImportDialog } from '../imports/ImportDialog';
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
  const [importFile, setImportFile] = useState<AudioFileChoice | null>(null);

  const isCapturing =
    recorderState === 'recording' || recorderState === 'paused' || recorderState === 'processing';

  return (
    <section className="rail" aria-label="Sessions">
      <header className="rail__head">
        <h2 className="rail__title">Sessions</h2>
        <div className="rail__head-actions">
          <Button
            variant="quiet"
            icon="upload"
            onClick={() => {
              setCreationError('');
              void window.audiohelper.chooseAudioFile()
                .then((chosen) => { if (chosen) setImportFile(chosen); })
                .catch((err: unknown) => setCreationError(err instanceof Error ? err.message : String(err)));
            }}
            aria-label="Import audio"
            title="Import an audio file"
          />
          <Button
            variant="quiet"
            icon="plus"
            onClick={() => { setCreationError(''); void newSession().catch((err: unknown) => setCreationError(err instanceof Error ? err.message : String(err))); }}
            disabled={isCapturing}
            aria-label="New session"
            title={isCapturing ? 'Stop recording to start a new session' : 'New session'}
          />
        </div>
      </header>

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
        </button>
        <button
          className="rail__foot-btn"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
        >
          <Icon name="settings" size={16} />
        </button>
      </div>

      {importFile && (
        <ImportDialog
          file={importFile}
          onClose={() => setImportFile(null)}
          onCreated={(created) => {
            setImportFile(null);
            window.dispatchEvent(new CustomEvent('skaz-import-started', { detail: created }));
          }}
        />
      )}
    </section>
  );
}
