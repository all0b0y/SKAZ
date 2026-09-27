import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { clsx } from 'clsx';
import { RecoveryStatus } from './RecoveryStatus';
import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { formatTimecode } from '../../lib/time';
import { FLOOR_DBFS } from '../../audio/meter';
import { IMPORT_RECORDING_MESSAGE } from '../../lib/recordingEligibility';
import { SETUP_HINTS, transcriptionSetupIssue } from '../../lib/transcriptionSetup';
import { TranscriptionSetupNotice } from './TranscriptionSetupNotice';
import { RecorderSources } from './RecorderSources';
import { useTranscriptIssue } from '../../state/transcriptIssue';


/** How many rounded bars the running waveform keeps on screen (~4s of history). */
const WAVE_BARS = 34;
/** How long the capsule says Done after the transcript has finished. */
const DONE_MS = 1_500;

// A running capsule of rounded bars, like the iPhone Voice Memos meter: each
// bar is one loudness sample, new samples enter on the right and older ones
// scroll off the left, so the strip answers "was I being picked up over the
// last few seconds", not just "right now". Bars are scaled with transform so
// the meter never triggers layout; when capture pauses they fall back to a
// flat line through the same transition.
//
// Note on honesty: there is no speech detection in the project. These bars
// are loudness history and nothing more; no bar colour or height claims that
// someone was speaking. The only colour change is the real peak-risk signal.
//
// Owns its own `meter` subscription instead of receiving it as a prop from
// RecorderBar: the level updates up to 10x/second (Задача 6,
// docs/PERFORMANCE-PLAN.md Срез 2), and reading it at RecorderBar's top level
// re-ran the whole component — buttons, error, progress — on every tick even
// though only these bars change.
export function LevelWave({ active }: { active: boolean }) {
  const meter = useStore((s) => s.meter);
  const [bars, setBars] = useState<number[]>(() => Array<number>(WAVE_BARS).fill(0));
  const normalized = active
    ? Math.min(1, Math.max(0, (meter.dbfs - FLOOR_DBFS) / -FLOOR_DBFS))
    : 0;
  // Keep the newest sample in a ref so the history effect depends only on the
  // meter tick, never re-running from unrelated re-renders.
  const latest = useRef(normalized);
  latest.current = normalized;

  useEffect(() => {
    if (!active) {
      setBars(Array<number>(WAVE_BARS).fill(0));
      return;
    }
    setBars((prev) => [...prev.slice(1), latest.current]);
  }, [active, meter]);

  const clipping = active && meter.clipping;
  const displayedDbfs = active ? Math.round(meter.dbfs) : FLOOR_DBFS;
  const peakDbfs = Math.round(meter.peakDbfs);
  const label = `Input level ${displayedDbfs} dBFS; peak ${peakDbfs} dBFS${clipping ? '; clipping risk' : ''}`;

  return (
    <span
      className="wave"
      role="img"
      aria-label={label}
      title={clipping ? `${displayedDbfs} dBFS · Clipping risk` : `${displayedDbfs} dBFS`}
      data-active={active}
      data-clip={clipping}
    >
      {bars.map((value, i) => (
        <span
          key={i}
          className="wave__bar"
          style={{ '--wave-level': value } as CSSProperties}
        />
      ))}
    </span>
  );
}

// Owns its own `elapsedMs` subscription instead of receiving it as a prop:
// the store ticks it every 250ms while recording (Задача 6,
// docs/PERFORMANCE-PLAN.md Срез 2), and reading it at RecorderBar's top level
// re-ran the whole component on every tick even though only this label
// changes. `live` is passed in — it derives from `recorderState`, which
// changes rarely, so it does not reintroduce the same cost.
function RecorderClock({ live }: { live: boolean }) {
  const elapsedMs = useStore((s) => s.elapsedMs);
  return (
    <span className="capsule__time tabular" data-live={live} aria-live="off">
      {formatTimecode(elapsedMs)}
    </span>
  );
}

// Owns its own `elapsedMs` subscription for the same reason as RecorderClock:
// the progress ratio is the only other consumer of the 250ms tick. Drawn as
// the capsule's bottom edge.
function RecorderProgress({
  capturing,
  finishing,
  transcribedThroughMs,
  transcriptionBacklog,
}: {
  capturing: boolean;
  finishing: boolean;
  transcribedThroughMs: number;
  transcriptionBacklog: boolean;
}) {
  const elapsedMs = useStore((s) => s.elapsedMs);
  // Honest transcription progress: the only real numbers on hand are how
  // much of the recording timeline has a finished segment (transcribedThroughMs,
  // real backend output) and how long the recording actually is (elapsedMs,
  // the recorder's own clock). After Stop nothing reports how much is left, so
  // the edge shows a moving sheen instead of a number. It never fabricates a
  // duration-based percentage.
  const hasDurationSignal = capturing && !finishing && elapsedMs > 0;
  const progressRatio = hasDurationSignal
    ? Math.min(1, transcribedThroughMs / elapsedMs)
    : null;
  const progressIndeterminate = progressRatio === null && (transcriptionBacklog || finishing);
  return (
    <div
      className="capsule__progress"
      role="progressbar"
      aria-label="Transcription progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressRatio !== null ? Math.round(progressRatio * 100) : undefined}
      data-indeterminate={progressIndeterminate}
    >
      <div
        className="capsule__progress-fill"
        style={progressRatio !== null ? { transform: `scaleX(${progressRatio})` } : undefined}
      />
    </div>
  );
}

/** One critical recording error inside the capsule: one line, the full text on
 * demand, a real action when one exists, and it stays until fixed or closed. */
interface CapsuleAction { label: string; run: () => void; icon?: 'retry' | 'settings' | 'mic' }

/** Waiting this long for the provider's confirmation offers the user a way out. */
export const FORCE_FINISH_OFFER_MS = 5_000;

/**
 * Stop is waiting for the transcription provider to confirm the rest of the
 * transcript. The wait follows the provider's status, not a timer; once it has
 * taken a while, the user may choose to finish now and keep what is confirmed.
 */
function FinalizingStatus({ elapsedMs, pendingMs, onForce }: {
  elapsedMs: number; pendingMs: number; onForce: () => void;
}) {
  const seconds = Math.max(1, Math.round(pendingMs / 1000));
  return (
    <span className="capsule__label capsule__finalizing" role="status">
      {pendingMs > 0 ? `Finishing transcript… ${seconds} s left to confirm` : 'Finishing transcript…'}
      {elapsedMs >= FORCE_FINISH_OFFER_MS && (
        <button type="button" className="capsule__error-action" onClick={onForce}
          title="Stop waiting; text confirmed so far is kept, the rest is not transcribed">
          Finish now
        </button>
      )}
    </span>
  );
}

function CapsuleError({ message, actions, onDismiss }: {
  message: string;
  actions: CapsuleAction[];
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="capsule__error" role="alert">
      <Icon name="warning" size={14} className="capsule__error-icon" />
      <button type="button" className="capsule__error-text" aria-expanded={open}
        title={message} onClick={() => setOpen((v) => !v)}>{message}</button>
      {actions.map((action) => <button key={action.label} type="button" className="capsule__error-action" title={action.label} onClick={action.run}>
        <Icon name={action.icon ?? 'retry'} size={13} /> <span className="capsule__error-action-label">{action.label}</span>
      </button>)}
      <button type="button" className="capsule__error-close" aria-label="Dismiss error" title="Dismiss" onClick={onDismiss}>
        <Icon name="close" size={13} />
      </button>
      {open && <p className="capsule__error-full">{message}</p>}
    </div>
  );
}

type CapsuleView = 'idle' | 'recording' | 'paused' | 'busy' | 'finishing' | 'done';

export function RecorderBar() {
  const state = useStore((s) => s.recorderState);
  const finishing = useStore((s) => s.finishing);
  const finalizing = useStore((s) => s.finalizing);
  const forceFinish = useStore((s) => s.forceFinishTranscription);
  const queue = useStore((s) => s.queue);
  const transcriptionPending = useStore((s) => s.transcription.pending + s.transcription.deferred);
  // Only the segments, not the whole `detail`: a durable audio save rebuilds
  // that object ~10x/second to flag notes stale (see TranscriptView), and
  // subscribing to it here would re-run every button/progress render on the
  // same cadence.
  const detailSegments = useStore((s) => s.detail?.segments);
  const session = useStore((s) => s.sessions.find((item) => item.id === s.activeSessionId));
  const recorderError = useStore((s) => s.recorderError);
  const pendingSessionStatus = useStore((s) => s.pendingSessionStatus);
  const recordingMode = useStore((s) => s.nextRecordingMode);
  const liveCapabilities = useStore((s) => s.liveCapabilities);
  // Only the derived reason, not the settings document: a settings refresh that
  // changes nothing relevant must not re-render the capsule.
  const setupIssue = useStore((s) => transcriptionSetupIssue(s.settings));

  const start = useStore((s) => s.startRecording);
  const pause = useStore((s) => s.pauseRecording);
  const resume = useStore((s) => s.resumeRecording);
  const stop = useStore((s) => s.stopRecording);
  const retry = useStore((s) => s.retryFailedUploads);
  const retrySessionStatus = useStore((s) => s.retrySessionStatus);
  const systemAudioIssue = useStore((s) => s.systemAudioIssue);
  // A critical transcript problem of THIS session (UI-CLEANUP §1).
  const activeSessionId = useStore((s) => s.activeSessionId);
  const transcriptIssue = useTranscriptIssue((s) => (s.issue && s.issue.sessionId === activeSessionId ? s.issue : null));

  const [dismissed, setDismissed] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => { setDismissed(null); }, [state, session?.id, recorderError]);
  const wasFinishing = useRef(false);

  const capturing = state === 'recording' || state === 'paused' || state === 'processing';
  const isFinishing = state === 'processing' && finishing;
  const failedCount = queue.failed.length;
  const imported = session?.origin === 'import';
  const contextualDisabled = recordingMode === 'contextual_local' && !liveCapabilities?.capable;
  // Starting (or continuing) without a way to transcribe would record audio
  // the user expects to see as text; the reason is stated on the capsule and
  // the transcript pane offers the way into Settings.
  const setupHint = setupIssue ? SETUP_HINTS[setupIssue] : null;
  const hasRecording = Boolean(session && (session.duration_ms > 0 || (detailSegments?.length ?? 0) > 0));

  // A protected local save is a storage failure even when nothing else wrote an
  // error: it must stay visible with its retry, never disappear with the pills.
  const recordingProblem = recorderError
    ?? (queue.overflow ? 'Capture stopped · buffered audio retained for retry'
      : failedCount > 0 ? `${failedCount} local save${failedCount > 1 ? 's' : ''} failed` : null);
  // Recording problems win: they risk losing audio; a transcript problem only
  // hides text that is already stored.
  const errorMessage = recordingProblem ?? transcriptIssue?.message ?? null;
  const errorActions: CapsuleAction[] = recordingProblem === null
    ? (transcriptIssue?.action ? [{ label: transcriptIssue.action.label, run: transcriptIssue.action.run }] : [])
    : pendingSessionStatus
    ? [{ label: `Retry ${pendingSessionStatus === 'stopped' ? 'stop' : pendingSessionStatus === 'paused' ? 'pause' : 'recording'} confirmation`, run: () => { void retrySessionStatus(); } }]
    : failedCount > 0 || queue.overflow ? [{ label: 'Retry saving', run: retry }]
      // System audio refused at start/resume: nothing was recorded, offer both ways on.
      : systemAudioIssue && systemAudioIssue.phase !== 'lost' ? [
        ...(systemAudioIssue.reason === 'denied' && window.skaz?.openSystemAudioSettings
          ? [{ label: 'Open System Settings', icon: 'settings' as const, run: () => { void window.skaz.openSystemAudioSettings?.(); } }] : []),
        { label: 'Record mic only', icon: 'mic' as const,
          run: () => { void (systemAudioIssue.phase === 'resume' || hasRecording ? resume({ micOnly: true }) : start({ micOnly: true })); } },
      ] : [];
  const showError = errorMessage !== null && errorMessage !== dismissed;

  useEffect(() => {
    if (isFinishing) { wasFinishing.current = true; setDone(false); return undefined; }
    if (!wasFinishing.current) return undefined;
    wasFinishing.current = false;
    if (state !== 'stopped' || errorMessage) return undefined;
    setDone(true);
    const timer = setTimeout(() => setDone(false), DONE_MS);
    return () => clearTimeout(timer);
  }, [isFinishing, state, errorMessage]);

  const view: CapsuleView = state === 'recording' ? 'recording'
    : state === 'paused' ? 'paused'
      : isFinishing ? 'finishing'
        : state === 'processing' ? 'busy'
          : done ? 'done' : 'idle';

  // Honest transcription progress: the real number on hand is how much of
  // the recording timeline has a finished segment (detailSegments, whose
  // end_ms is real backend output). The elapsed-time half of the ratio lives
  // in RecorderProgress, which owns the 250ms `elapsedMs` tick on its own so
  // this component does not re-render on every tick.
  const transcribedThroughMs = detailSegments?.length
    ? detailSegments.reduce((max, seg) => Math.max(max, seg.end_ms), 0)
    : 0;
  const transcriptionBacklog = transcriptionPending > 0 || queue.pending > 0;

  return (
    <div className={clsx('recorder', imported && 'recorder--imported')}>
      {imported && <p id="import-recording-explanation">{IMPORT_RECORDING_MESSAGE}</p>}
      {!imported && !capturing && <TranscriptionSetupNotice />}
      <RecoveryStatus sessionId={session?.id} active={state === 'recording'} />
      <div className={clsx('capsule', showError && 'capsule--error')} data-state={view}>
        <span className="visually-hidden" role="status">
          {view === 'recording' ? 'Recording' : view === 'paused' ? 'Paused' : ''}
        </span>

        {(view === 'recording' || view === 'paused') && <span className="capsule__dot" aria-hidden="true" />}

        {(view === 'idle' || view === 'done') && (
          <Button
            key="record"
            className="capsule__primary"
            variant="live"
            icon={hasRecording ? 'play' : 'mic'}
            iconFilled={hasRecording}
            disabled={imported || contextualDisabled || setupHint !== null}
            aria-describedby={imported ? 'import-recording-explanation' : setupHint ? 'recorder-setup-hint' : undefined}
            title={imported ? IMPORT_RECORDING_MESSAGE : contextualDisabled ? liveCapabilities?.detail ?? undefined
              : setupHint ?? (hasRecording ? 'Continue recording' : 'Record')}
            onClick={() => void (hasRecording ? resume() : start())}
          >
            {hasRecording ? 'Continue recording' : 'Record'}
          </Button>
        )}
        {(view === 'idle' || view === 'done') && !imported && setupHint && (
          <span id="recorder-setup-hint" className="capsule__label capsule__setup">
            <Icon name="warning" size={13} /> {setupHint}
          </span>
        )}
        {view === 'busy' && (
          <Button key="busy" className="capsule__round" variant="quiet" icon="dot" disabled
            aria-label="Processing…" title="Processing…" />
        )}
        {view === 'finishing' && (
          <Button key="finishing" className="capsule__round capsule__spinner" variant="quiet" icon="mic" disabled
            aria-label="Finishing transcript…" title="Recording is available again once the transcript is finished" />
        )}

        {finalizing && (view === 'finishing' || view === 'busy') ? (
          <FinalizingStatus elapsedMs={finalizing.elapsedMs} pendingMs={finalizing.pendingMs} onForce={() => void forceFinish()} />
        ) : view === 'finishing' ? (
          <span className="capsule__label">Finishing transcript…</span>
        ) : view === 'done' ? (
          <span className="capsule__label capsule__done" role="status"><Icon name="check" size={14} /> Done</span>
        ) : null}

        <RecorderClock live={state === 'recording'} />

        {(view === 'recording' || view === 'paused') && <LevelWave active={state === 'recording'} />}

        {view === 'recording' && (
          <Button key="pause" className="capsule__round capsule__morph" variant="quiet" icon="pause" aria-label="Pause" title="Pause" onClick={() => void pause()} />
        )}
        {view === 'paused' && (
          <Button key="resume" className="capsule__round capsule__morph" variant="live" icon="play" iconFilled aria-label="Resume" title="Resume" onClick={() => void resume()} />
        )}
        {(view === 'recording' || view === 'paused' || view === 'busy') && (
          <Button key="stop" className="capsule__round" variant="danger" icon="stop" aria-label="Stop" title="Stop" onClick={() => void stop()} />
        )}

        {!imported && (view === 'idle' || view === 'done' || view === 'recording' || view === 'paused') && (
          <RecorderSources hasRecording={hasRecording} />
        )}

        {showError && <CapsuleError message={errorMessage} actions={errorActions} onDismiss={() => setDismissed(errorMessage)} />}

        <RecorderProgress
          capturing={capturing}
          finishing={isFinishing}
          transcribedThroughMs={transcribedThroughMs}
          transcriptionBacklog={transcriptionBacklog}
        />
      </div>
    </div>
  );
}
