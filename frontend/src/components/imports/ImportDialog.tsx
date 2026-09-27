import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { ApiClient } from '../../api/client';
import type { AudioFileChoice } from '../../api/bridge';
import type { ImportCapabilities, ImportCreated, ImportPreview } from '../../api/types';
import { Button } from '../ui/Button';
import { SessionDialog } from '../sessions/SessionOverlays';
import './importDialog.css';

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

export interface ImportDetailsProps {
  file: AudioFileChoice;
  preview?: ImportPreview;
  onOpenExisting?: (id: string) => void;
  onOpenSettings?: () => void;
  onClose: () => void;
  onCreated: (created: ImportCreated) => void;
  onBusyChange?: (busy: boolean) => void;
}

/**
 * The second step of an import, once the source is known
 * (.dev/docs/UI-CLEANUP-IMPORT-TRANSCRIPT-SPEC.md §5): the session name, the mode
 * as a two-way switch, one summary line, one fine-print line, and at most one
 * warning line — no coloured boxes. Behaviour is unchanged: nothing is sent
 * until Transcribe, a price over the threshold needs a second click, and a
 * duplicate needs an explicit choice.
 */
export function ImportDetails({ file, preview, onOpenExisting, onOpenSettings, onClose, onCreated, onBusyChange }: ImportDetailsProps) {
  const [caps, setCaps] = useState<ImportCapabilities | null>(null);
  const [capsError, setCapsError] = useState('');
  const [title, setTitle] = useState(() => preview?.title ?? file.name.replace(/\.[^.]+$/, ''));
  const [translate, setTranslate] = useState(false);
  const [duration, setDuration] = useState<number | null | undefined>(preview?.duration_ms);
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState('');
  const [confirmedExpensive, setConfirmedExpensive] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const setBusy = (value: boolean) => { setBusyState(value); onBusyChange?.(value); };

  useEffect(() => {
    let alive = true;
    void new ApiClient(window.skaz).getImportCapabilities()
      .then((value) => { if (alive) setCaps(value); })
      .catch((err: unknown) => {
        if (alive) setCapsError(err instanceof Error ? err.message : String(err));
      });
    if (!preview) void readDuration(file.url).then((value) => { if (alive) setDuration(value); });
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
  const duplicate = !!preview?.existing_session_ids.length;
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
    void new ApiClient(window.skaz)
      .createImport({
        ...(preview ? { source: preview.source, allow_duplicate: allowDuplicate } : { path: file.path }),
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

  // The one blocking reason, most fundamental first; fixable ones link to Settings.
  const blocker: { text: string; settings: boolean } | null =
    caps && !caps.cloud_consent
      ? { text: 'Import sends the audio file to Soniox. Turn on cloud processing in Settings → API keys.', settings: true }
      : caps && !caps.has_api_key
        ? { text: 'No Soniox key is saved. Add it in Settings → API keys.', settings: true }
        : tooLong
          ? { text: `The file is longer than ${formatDuration(caps!.max_duration_ms)} — the provider does not accept it.`, settings: false }
          : null;

  return (
    <div className="import-dialog__details">
      <label className="import-dialog__field">
        <span>Session name</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} disabled={busy} />
      </label>

      <div className="import-dialog__switch" role="radiogroup" aria-label="What to do">
        {([[false, 'Transcription', 'Transcription only'], [true, '+ Translation', 'Transcription and translation']] as const)
          .map(([value, label, name]) => (
            <button key={label} type="button" role="radio" aria-checked={translate === value} aria-label={name} disabled={busy}
              className={clsx('import-dialog__switch-option', translate === value && 'import-dialog__switch-option--on')}
              onClick={() => setTranslate(value)}>
              {label}
            </button>
          ))}
      </div>

      <p className="import-dialog__summary">
        <span>{duration === undefined ? 'reading…' : duration === null ? 'could not be read from the file' : formatDuration(duration)}</span>
        <span aria-hidden="true"> · </span>
        <span>
          {estimate != null && rate != null
            ? `≈ ${formatCost(estimate)}`
            : rate != null
              ? `≈ $${rate.toFixed(2)} per audio hour — the exact amount is shown after processing`
              : '—'}
        </span>
        <span aria-hidden="true"> · </span>
        <span>Saved to <span>{caps ? caps.destination : '—'}</span></span>
      </p>

      <p className="import-dialog__note">
        An estimate, not a bill{rate != null && estimate != null ? ` ($${rate.toFixed(2)} per audio hour)` : ''}: the provider
        charges by its own tokens. The original file stays where it is; temporary audio is deleted afterwards.
      </p>

      {blocker && (
        <p role="alert" className="import-dialog__line">
          {blocker.text}
          {blocker.settings && onOpenSettings && (
            <> <button type="button" className="import-dialog__link" onClick={onOpenSettings}>Open settings</button></>
          )}
        </p>
      )}
      {queued && !blocked && (
        <p className="import-dialog__line">Another import is active. Open it to continue or cancel.</p>
      )}
      {capsError && <p role="alert" className="import-dialog__line">{capsError}</p>}
      {error && <p role="alert" className="import-dialog__line">{error}</p>}

      <div className="import-dialog__footer">
        <div className="import-dialog__caption">
          {duplicate && (
            <>
              <span>This video already has a session.</span>{' '}
              <button type="button" className="import-dialog__link" onClick={() => onOpenExisting?.(preview!.existing_session_ids[0]!)}>
                Open existing
              </button>
              <label className="import-dialog__check">
                <input type="checkbox" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} />
                Transcribe again (new paid run)
              </label>
            </>
          )}
          {expensive && (
            <span role="alert">
              This costs more than your threshold of {formatCost(caps!.warn_above_usd!)}.
              {confirmedExpensive
                ? ` Press again to continue for ≈ ${formatCost(estimate!)}.`
                : ` Continue for ≈ ${formatCost(estimate!)}?`}
            </span>
          )}
        </div>
        <div className="import-dialog__actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || caps == null || blocked || tooLong || queued || title.trim().length === 0 || (duplicate && !allowDuplicate)}
          >
            {/* The label only changes once the warning has been shown and
                acknowledged; renaming it up front would make the first click
                look like it did nothing. */}
            {expensive && confirmedExpensive ? 'Transcribe anyway' : 'Transcribe'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The details step on its own, for a source already chosen outside the dialog. */
export function ImportDialog(props: Omit<ImportDetailsProps, 'onBusyChange'>) {
  const [busy, setBusy] = useState(false);
  return (
    <SessionDialog title="Import media" onClose={props.onClose} busy={busy}>
      <div className="import-dialog">
        <p className="import-dialog__file" title={props.file.path}>{props.file.name}</p>
        <ImportDetails {...props} onBusyChange={setBusy} />
      </div>
    </SessionDialog>
  );
}
