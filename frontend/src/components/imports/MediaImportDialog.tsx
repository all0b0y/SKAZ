import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ApiClient } from '../../api/client';
import type { AudioFileChoice } from '../../api/bridge';
import type { ImportCreated, ImportPreview, MediaSource } from '../../api/types';
import { SessionDialog } from '../sessions/SessionOverlays';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ImportDetails } from './ImportDialog';

interface Props {
  onClose: () => void;
  onCreated: (value: ImportCreated) => void;
  onOpenExisting: (id: string) => void;
  onOpenSettings?: () => void;
}

/** Only a link that looks like YouTube is checked on its own; anything else waits. */
const LOOKS_LIKE_YOUTUBE = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\/\S+$/i;
const CHECK_DELAY_MS = 450;

/**
 * One dialog that unfolds step by step (.dev/docs/UI-CLEANUP-IMPORT-TRANSCRIPT-SPEC.md §5).
 *
 * Step 1: a link field that checks itself once a YouTube link is in it, and
 * "Choose file" next to it; a file can be dropped anywhere on the dialog. Step 2:
 * the chosen source collapses to one line with "Change", and the details follow.
 * Source selection never submits a paid job, and a stale preview cannot replace
 * a newer choice.
 */
export function MediaImportDialog({ onClose, onCreated, onOpenExisting, onOpenSettings }: Props) {
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<AudioFileChoice | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  const inspect = async (source: MediaSource) => {
    const version = ++generation.current;
    setPreview(null); setError(''); setChecking(true);
    try {
      const result = await new ApiClient(window.skaz).previewImport(source);
      if (version === generation.current) setPreview(result);
    } catch (err) {
      if (version === generation.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (version === generation.current) setChecking(false);
    }
  };

  // A pasted or typed YouTube link is checked by itself, after a short pause.
  useEffect(() => {
    const link = url.trim();
    if (!link || file || !LOOKS_LIKE_YOUTUBE.test(link)) return undefined;
    const timer = setTimeout(() => { void inspect({ kind: 'youtube', url: link }); }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, file]);

  const selectFile = (choice: AudioFileChoice) => {
    setFile(choice); setUrl('');
    void inspect({ kind: 'local', path: choice.path });
  };
  const choose = async () => {
    try {
      const choice = await window.skaz.chooseAudioFile();
      if (choice) selectFile(choice);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const change = () => {
    generation.current++;
    setPreview(null); setFile(null); setUrl(''); setError(''); setChecking(false);
  };
  const drop = (files: FileList) => {
    if (checking || busy) return;
    if (files.length !== 1) { setError('Choose one audio or video file.'); return; }
    try {
      const choice = window.skaz.droppedMediaFile?.(files[0]!);
      if (choice) selectFile(choice);
      else setError('This file could not be opened. Choose it instead.');
    } catch { setError('This file could not be opened. Choose it instead.'); }
  };

  const chosen = preview !== null;
  const name = preview?.title ?? file?.name ?? '';
  const youtube = preview?.source.kind === 'youtube';

  return (
    <SessionDialog title="Import media" onClose={onClose} busy={busy}>
      <div
        className={clsx('import-dialog', dragging && 'import-dialog--dragging')}
        onDragOver={(e) => { e.preventDefault(); if (!chosen) setDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!chosen) drop(e.dataTransfer.files); }}
      >
        {chosen ? (
          <div className="import-dialog__source">
            <span className="import-dialog__source-icon" aria-hidden="true">
              <Icon name={youtube ? 'globe' : 'waveform'} size={16} />
            </span>
            <span className="import-dialog__source-name" title={name}>{name}</span>
            <button type="button" className="import-dialog__link" onClick={change} disabled={busy}>Change</button>
          </div>
        ) : (
          <>
            <div className="import-dialog__pick">
              <input
                className="import-dialog__url"
                value={url}
                aria-label="YouTube link"
                placeholder="Paste a YouTube link"
                maxLength={4096}
                onChange={(e) => {
                  generation.current++; setChecking(false); setUrl(e.target.value); setFile(null); setPreview(null); setError('');
                }}
              />
              <Button onClick={() => void choose()} disabled={checking}>Choose file</Button>
            </div>
            <p className="import-dialog__status" role={checking ? 'status' : undefined}>
              {checking ? 'Checking media…' : dragging ? 'Drop the file to import it' : 'Or drop an audio or video file here.'}
            </p>
          </>
        )}
        {error && <p role="alert" className="import-dialog__line">{error}</p>}

        {chosen ? (
          <ImportDetails
            key={JSON.stringify(preview.source)}
            file={file ?? { path: '', url: '', name: preview.title }}
            preview={preview}
            onClose={onClose}
            onCreated={onCreated}
            onOpenExisting={onOpenExisting}
            onOpenSettings={onOpenSettings}
            onBusyChange={setBusy}
          />
        ) : (
          <>
            <p className="import-dialog__note">
              One public YouTube video or one local file, processed in full. No playlists, live streams or sign-in.
              Only import media you have permission to process.
            </p>
            <div className="import-dialog__actions">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </SessionDialog>
  );
}
