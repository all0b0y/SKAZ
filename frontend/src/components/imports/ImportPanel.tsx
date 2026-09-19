import { useEffect, useRef, useState } from 'react';
import { ApiClient } from '../../api/client';
import type { ImportView } from '../../api/types';
import { Button } from '../ui/Button';
import { formatDuration } from './ImportDialog';
import './importPanel.css';

const POLL_MS = 1500;

const STATUS_LABEL: Record<ImportView['status'], string> = {
  queued: 'В очереди',
  uploading: 'Отправляем файл',
  processing: 'Провайдер обрабатывает',
  completed: 'Готово',
  failed: 'Не удалось',
  cancelled: 'Отменено',
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
    return <section className="import-panel" aria-busy="true"><p>Загружаем состояние импорта…</p></section>;
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
        {duration != null && (<><dt>Длительность</dt><dd>{formatDuration(duration)}</dd></>)}
        <dt>Режим</dt>
        <dd>{state.translate ? 'Транскрипция и перевод' : 'Только транскрипция'}</dd>
        {running && (<><dt>Прошло</dt><dd>{elapsed(state.created_at, now)}</dd></>)}
        {!state.source.available && (
          <>
            <dt>Исходный файл</dt>
            <dd>Недоступен по прежнему пути — расшифровка и заметки продолжают работать</dd>
          </>
        )}
      </dl>

      {running && (
        <p className="import-panel__note">
          Работа идёт на стороне провайдера. Приложение можно закрыть — импорт продолжится
          и подхватится при следующем запуске. Точного процента провайдер не сообщает.
        </p>
      )}
      {state.status === 'failed' && state.error && (
        <p role="alert" className="import-panel__error">{state.error}</p>
      )}
      {state.status === 'cancelled' && (
        <p className="import-panel__note">
          Импорт отменён. Уже обработанная часть аудио могла быть тарифицирована провайдером.
        </p>
      )}
      {error && <p role="alert" className="import-panel__error">{error}</p>}

      <div className="import-panel__actions">
        {running && (
          <Button variant="danger" onClick={cancel} disabled={busy}>Отменить импорт</Button>
        )}
        {(state.status === 'failed' || state.status === 'cancelled') && (
          <>
            <Button variant="primary" icon="retry" onClick={retry} disabled={busy}>
              Повторить (новый платный запуск)
            </Button>
            <Button variant="ghost" icon="trash" onClick={remove} disabled={busy}>
              Удалить сессию
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
