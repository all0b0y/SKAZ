import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ApiClient } from '../../api/client';
import type { ImportView } from '../../api/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { SessionDialog } from '../sessions/SessionOverlays';
import { formatDuration } from './ImportDialog';
import './importPanel.css';

const POLL_MS = 1500;

const STATUS_LABEL: Record<ImportView['status'], string> = {
  queued: 'Starting',
  downloading: 'Downloading audio',
  preparing: 'Preparing audio',
  interrupted: 'Import interrupted',
  uploading: 'Uploading file',
  processing: 'Provider is processing',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const RUNNING: ImportView['status'][] = ['queued', 'downloading', 'preparing', 'uploading', 'processing'];

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

/** What an in-flight or failed import shows in the main area
 * (.dev/docs/UI-CLEANUP-IMPORT-TRANSCRIPT-SPEC.md §4): one card centred in the
 * column, the same shape for every state.
 *
 * There is no percentage: Soniox reports queued/processing/completed and
 * nothing in between, so the running line is indeterminate and the elapsed
 * time — which is real — rides on the status line instead. Caveats appear where
 * they matter (the cancel confirmation, under Retry), not all the time.
 */
export function ImportPanel({ sessionId, onSettled, onDeleted }: Props) {
  const [state, setState] = useState<ImportView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The callback identity must not restart polling: callers pass inline arrows,
  // and a restart on every parent render would reset the backoff and the clock.
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const api = new ApiClient(window.skaz);
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
    return (
      <div className="import-panel">
        <section className="import-card" aria-busy="true">
          <p className="import-card__line">Loading import status…</p>
        </section>
      </div>
    );
  }

  const running = RUNNING.includes(state.status);
  const stuck = state.status === 'failed' || state.status === 'interrupted';
  const duration = state.audio_duration_ms ?? state.declared_duration_ms ?? null;
  const youtube = state.source.kind === 'youtube';

  const cancel = () => {
    setConfirmCancel(false);
    setBusy(true);
    void new ApiClient(window.skaz).cancelImport(sessionId)
      .then((value) => { setState(value); onSettled(value); if (value.status === 'cancelled') onDeleted(); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const retry = () => {
    setBusy(true);
    void new ApiClient(window.skaz).retryImport(sessionId)
      .then((created) => { window.dispatchEvent(new CustomEvent('skaz-import-started', { detail: created })); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const remove = () => {
    setBusy(true);
    void new ApiClient(window.skaz).deleteImport(sessionId)
      .then(onDeleted)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  // One status line: status · elapsed · duration · mode.
  const facts = [
    running ? elapsed(state.created_at, now) : null,
    duration != null ? formatDuration(duration) : null,
    state.translate ? 'Transcription + translation' : 'Transcription',
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <div className="import-panel">
      <section className={clsx('import-card', `import-card--${state.status}`)} aria-live="polite" aria-busy={running}>
        <header className="import-card__head">
          <span className="import-card__icon" aria-hidden="true">
            <Icon name={youtube ? 'globe' : 'waveform'} size={18} />
          </span>
          <h2 className="import-card__title" title={state.source.name}>{state.source.name}</h2>
        </header>

        <p className="import-card__line">
          <strong className="import-card__status">{STATUS_LABEL[state.status]}</strong>
          {facts.map((fact) => <span key={fact}> · {fact}</span>)}
        </p>

        {running && <div className="import-card__progress" aria-hidden="true"><span /></div>}

        {state.status === 'failed' && state.error && (
          <p role="alert" className="import-card__error">{state.error}</p>
        )}
        {state.status === 'cancelled' && (
          <p className="import-card__hint">The provider may have charged for the audio already processed.</p>
        )}
        {!youtube && !state.source.available && (
          <p className="import-card__hint">
            Original file not available at its previous path — the transcript and notes keep working.
          </p>
        )}
        {error && <p role="alert" className="import-card__error">{error}</p>}

        {(running || stuck) && (
          <div className="import-card__actions">
            {running && (
              <Button variant="ghost" onClick={() => setConfirmCancel(true)} disabled={busy}>Cancel import</Button>
            )}
            {stuck && (
              <>
                <Button variant="ghost" icon="trash" onClick={remove} disabled={busy}>Delete</Button>
                <Button variant="primary" icon="retry" onClick={retry} disabled={busy}>Retry</Button>
              </>
            )}
          </div>
        )}
        {stuck && (
          <p className="import-card__hint import-card__hint--end">
            Retry checks the existing job first; if it definitively failed, a new paid transcription is created.
          </p>
        )}
      </section>

      {confirmCancel && (
        <SessionDialog title="Cancel import?" onClose={() => setConfirmCancel(false)}>
          <p>Cancelling or closing the app may not stop provider charges for audio already sent.</p>
          <div className="session-dialog__actions">
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>Keep importing</Button>
            <Button variant="danger" onClick={cancel}>Cancel import</Button>
          </div>
        </SessionDialog>
      )}
    </div>
  );
}
