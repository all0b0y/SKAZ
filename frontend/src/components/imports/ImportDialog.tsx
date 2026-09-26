import { useEffect, useMemo, useState } from 'react';
import { ApiClient } from '../../api/client';
import type { AudioFileChoice } from '../../api/bridge';
import type { ImportCapabilities, ImportCreated } from '../../api/types';
import { Button } from '../ui/Button';
import { SessionDialog } from '../sessions/SessionOverlays';
import './importDialog.css';

interface Props {
  file: AudioFileChoice;
  onClose: () => void;
  onCreated: (created: ImportCreated) => void;
}

/** Duration read from the container metadata, in ms, or null when unreadable. */
export async function readDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = new Audio();
    // Metadata only: decoding a two-hour lecture in the renderer would cost
    // hundreds of megabytes to learn a single number.
    audio.preload = 'metadata';
    const done = (value: number | null) => {
      audio.removeAttribute('src');
      resolve(value);
    };
    audio.addEventListener('loadedmetadata', () => {
      const seconds = audio.duration;
      done(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
    });
    audio.addEventListener('error', () => done(null));
    audio.src = url;
  });
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}

/** Estimated, never a quote: Soniox bills its own tokens, we bill nothing. */
export function estimateCost(ms: number, ratePerHourUsd: number): number {
  return (ms / 3_600_000) * ratePerHourUsd;
}

function formatCost(value: number): string {
  return `$${value < 0.01 ? value.toFixed(3) : value.toFixed(2)}`;
}

export function ImportDialog({ file, onClose, onCreated }: Props) {
  const [caps, setCaps] = useState<ImportCapabilities | null>(null);
  const [capsError, setCapsError] = useState('');
  const [title, setTitle] = useState(() => file.name.replace(/\.[^.]+$/, ''));
  const [translate, setTranslate] = useState(false);
  const [duration, setDuration] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmedExpensive, setConfirmedExpensive] = useState(false);

  useEffect(() => {
    let alive = true;
    void new ApiClient(window.audiohelper).getImportCapabilities()
      .then((value) => { if (alive) setCaps(value); })
      .catch((err: unknown) => {
        if (alive) setCapsError(err instanceof Error ? err.message : String(err));
      });
    void readDuration(file.url).then((value) => { if (alive) setDuration(value); });
    return () => { alive = false; };
  }, [file.url]);

  const rate = caps
    ? (translate ? caps.translation_rate_per_hour_usd : caps.rate_per_hour_usd)
    : null;
  const estimate = useMemo(
    () => (duration != null && rate != null ? estimateCost(duration, rate) : null),
    [duration, rate],
  );
  const tooLong = caps != null && duration != null && duration > caps.max_duration_ms;
  const blocked = caps != null && (!caps.cloud_consent || !caps.has_api_key);
  const queued = caps != null && caps.active_imports >= caps.max_concurrent_imports;
  const expensive =
    caps?.warn_above_usd != null && estimate != null && estimate > caps.warn_above_usd
    && !tooLong && !blocked;
  const needsSecondClick = expensive && !confirmedExpensive;

  // Re-arm the second click whenever the price changes under the user.
  useEffect(() => { setConfirmedExpensive(false); }, [translate, duration]);

  const submit = () => {
    if (needsSecondClick) { setConfirmedExpensive(true); return; }
    setBusy(true);
    setError('');
    void new ApiClient(window.audiohelper)
      .createImport({
        path: file.path,
        title: title.trim() || file.name,
        translate,
        declared_duration_ms: duration ?? null,
      })
      .then(onCreated)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  };

  return (
    <SessionDialog title="Import audio file" onClose={onClose} busy={busy}>
      <div className="import-dialog">
        <p className="import-dialog__file" title={file.path}>{file.name}</p>

        <label className="import-dialog__field">
          <span>Session name</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            disabled={busy}
          />
        </label>

        <fieldset className="import-dialog__modes" disabled={busy}>
          <legend>What to do</legend>
          <label>
            <input
              type="radio"
              name="import-mode"
              checked={!translate}
              onChange={() => setTranslate(false)}
            />
            <span>Transcription only</span>
          </label>
          <label>
            <input
              type="radio"
              name="import-mode"
              checked={translate}
              onChange={() => setTranslate(true)}
            />
            <span>Transcription and translation</span>
          </label>
        </fieldset>

        <dl className="import-dialog__facts">
          <dt>Duration</dt>
          <dd>
            {duration === undefined
              ? 'reading…'
              : duration === null
                ? 'could not be read from the file'
                : formatDuration(duration)}
          </dd>
          <dt>Estimated cost</dt>
          <dd>
            {estimate != null && rate != null
              ? `≈ ${formatCost(estimate)} (at $${rate.toFixed(2)} per audio hour)`
              : rate != null
                ? `≈ $${rate.toFixed(2)} per audio hour — the exact amount is shown after processing`
                : '—'}
          </dd>
          <dt>Saved to</dt>
          <dd>{caps ? caps.destination : '—'}</dd>
        </dl>

        <p className="import-dialog__note">
          An estimate, not a bill: the provider charges by its own tokens. The original file
          stays where it is; the app does not copy it.
        </p>

        {tooLong && (
          <p role="alert" className="import-dialog__error">
            The file is longer than {formatDuration(caps!.max_duration_ms)} — the provider does not accept it.
          </p>
        )}
        {caps && !caps.cloud_consent && (
          <p role="alert" className="import-dialog__error">
            Import sends the audio file to Soniox. Turn on cloud processing
            in Settings → API keys.
          </p>
        )}
        {caps && caps.cloud_consent && !caps.has_api_key && (
          <p role="alert" className="import-dialog__error">
            No Soniox key is saved. Add it in Settings → API keys.
          </p>
        )}
        {queued && !blocked && (
          <p className="import-dialog__warning">
            {caps!.active_imports} import(s) already running — this one will be queued.
          </p>
        )}
        {expensive && (
          <p role="alert" className="import-dialog__warning">
            This costs more than your threshold of {formatCost(caps!.warn_above_usd!)}.
            {confirmedExpensive
              ? ` Press again to continue for ≈ ${formatCost(estimate!)}.`
              : ` Continue for ≈ ${formatCost(estimate!)}?`}
          </p>
        )}
        {capsError && <p role="alert" className="import-dialog__error">{capsError}</p>}
        {error && <p role="alert" className="import-dialog__error">{error}</p>}

        <div className="import-dialog__actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || caps == null || blocked || tooLong || title.trim().length === 0}
          >
            {/* The label only changes once the warning has been shown and
                acknowledged; renaming it up front would make the first click
                look like it did nothing. */}
            {expensive && confirmedExpensive ? 'Transcribe anyway' : 'Transcribe'}
          </Button>
        </div>
      </div>
    </SessionDialog>
  );
}
