import { useEffect, useRef, useState } from 'react';
import { ApiClient } from '../../api/client';
import type { ImportView } from '../../api/types';
import { Button } from '../ui/Button';
import { formatDuration } from './ImportDialog';
import './importPanel.css';

const POLL_MS = 1500;

const STATUS_LABEL: Record<ImportView['status'], string> = {
  queued: 'Queued',
  uploading: 'Uploading file',
  processing: 'Provider is processing',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function elapsed(fromIso: string, now: number): string {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

interface Props {
  sessionId: string;
  onSettled: (state: ImportView) => void;
  onDeleted: () => void;
}

/** What an in-flight or failed import shows in the main area.
 *
 * There is no progress bar: Soniox reports queued/processing/completed and
 * nothing in between, so a percentage would be invented. Elapsed time is real
 * and is what we show instead.
 */
export function ImportPanel({ sessionId, onSettled, onDeleted }: Props) {
  const [state, setState] = useState<ImportView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The callback identity must not restart polling: callers pass inline arrows,
  // and a restart on every parent render would reset the backoff and the clock.
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const api = new ApiClient(window.audiohelper);
    const tick = () => {
      void api.getImport(sessionId)
        .then((value) => {
          if (!alive) return;
          setState(value);
          setError('');
          if (value.status === 'completed' || value.status === 'cancelled') settledRef.current(value);
          if (value.status !== 'completed' && value.status !== 'cancelled') {
            timer = setTimeout(tick, POLL_MS);
          }
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setError(err instanceof Error ? err.message : String(err));
          timer = setTimeout(tick, POLL_MS * 3);
        });
    };
    tick();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(clock); if (timer) clearTimeout(timer); };
  }, [sessionId]);

  if (!state) {
    return <section className="import-panel" aria-busy="true"><p>Loading import status…</p></section>;
  }

  const running = state.status === 'queued' || state.status === 'uploading' || state.status === 'processing';
  const duration = state.audio_duration_ms ?? state.declared_duration_ms ?? null;

  const cancel = () => {
    setBusy(true);
    void new ApiClient(window.audiohelper).cancelImport(sessionId)
      .then((value) => { setState(value); onSettled(value); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const retry = () => {
    setBusy(true);
    void new ApiClient(window.audiohelper).retryImport(sessionId)
      .then((created) => { window.dispatchEvent(new CustomEvent('skaz-import-started', { detail: created })); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const remove = () => {
    setBusy(true);
    void new ApiClient(window.audiohelper).deleteImport(sessionId)
      .then(onDeleted)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="import-panel" aria-live="polite" aria-busy={running}>
      <h2 className="import-panel__status">{STATUS_LABEL[state.status]}</h2>
      <p className="import-panel__file" title={state.source.path}>{state.source.name}</p>

      <dl className="import-panel__facts">
        {duration != null && (<><dt>Duration</dt><dd>{formatDuration(duration)}</dd></>)}
        <dt>Mode</dt>
        <dd>{state.translate ? 'Transcription and translation' : 'Transcription only'}</dd>
        {running && (<><dt>Elapsed</dt><dd>{elapsed(state.created_at, now)}</dd></>)}
        {!state.source.available && (
          <>
            <dt>Original file</dt>
            <dd>Not available at its previous path — the transcript and notes keep working</dd>
          </>
        )}
      </dl>

      {running && (
        <p className="import-panel__note">
          The provider is doing the work. You can close the app — the import continues
          and is picked up on the next launch. The provider does not report an exact percentage.
        </p>
      )}
      {state.status === 'failed' && state.error && (
        <p role="alert" className="import-panel__error">{state.error}</p>
      )}
      {state.status === 'cancelled' && (
        <p className="import-panel__note">
          Import cancelled. The provider may have charged for the audio already processed.
        </p>
      )}
      {error && <p role="alert" className="import-panel__error">{error}</p>}

      <div className="import-panel__actions">
        {running && (
          <Button variant="danger" onClick={cancel} disabled={busy}>Cancel import</Button>
        )}
        {(state.status === 'failed' || state.status === 'cancelled') && (
          <>
            <Button variant="primary" icon="retry" onClick={retry} disabled={busy}>
              Retry (new paid run)
            </Button>
            <Button variant="ghost" icon="trash" onClick={remove} disabled={busy}>
              Delete session
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
