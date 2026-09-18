import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { formatTimecode } from '../../lib/time';
import { FLOOR_DBFS, type MeterSnapshot } from '../../audio/meter';


/** How many rounded bars the running waveform keeps on screen (~4s of history). */
const WAVE_BARS = 34;

// A running capsule of rounded bars, like the iPhone Voice Memos meter: each
// bar is one loudness sample, new samples enter on the right and older ones
// scroll off the left, so the strip answers "was I being picked up over the
// last few seconds", not just "right now". Fixed height inside the bar row, so
// it cannot overflow the panel the way the old ring did.
//
// Note on honesty: audio/meter.ts always reports vad 'unavailable' — there is
// no real speech detection in the project. These bars are loudness history and
// nothing more; no bar colour or height claims that someone was speaking.
function LevelWave({ meter, active }: { meter: MeterSnapshot; active: boolean }) {
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

  const displayedDbfs = active ? Math.round(meter.dbfs) : FLOOR_DBFS;
  const peakDbfs = Math.round(meter.peakDbfs);
  const label = `Input level ${displayedDbfs} dBFS; peak ${peakDbfs} dBFS`;

  return (
    <span
      className="wave"
      role="img"
      aria-label={label}
      title={`${displayedDbfs} dBFS`}
      data-active={active}
      data-clip={active && meter.clipping}
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

export function RecorderBar() {
  const state = useStore((s) => s.recorderState);
  const elapsedMs = useStore((s) => s.elapsedMs);
  const meter = useStore((s) => s.meter);
  const queue = useStore((s) => s.queue);
  const transcription = useStore((s) => s.transcription);
  const detail = useStore((s) => s.detail);
  const session = useStore((s) => s.sessions.find((item) => item.id === s.activeSessionId));
  const recorderError = useStore((s) => s.recorderError);
  const pendingSessionStatus = useStore((s) => s.pendingSessionStatus);
  const recordingMode = useStore((s) => s.nextRecordingMode);
  const liveCapabilities = useStore((s) => s.liveCapabilities);

  const start = useStore((s) => s.startRecording);
  const pause = useStore((s) => s.pauseRecording);
  const resume = useStore((s) => s.resumeRecording);
  const stop = useStore((s) => s.stopRecording);
  const retry = useStore((s) => s.retryFailedUploads);
  const retryTranscription = useStore((s) => s.retryFailedTranscriptions);
  const retrySessionStatus = useStore((s) => s.retrySessionStatus);


  const capturing = state === 'recording' || state === 'paused' || state === 'processing';
  const failedCount = queue.failed.length;
  const transcriptionFailed = transcription.failed.length + transcription.diskFailed;
  const transcriptionPending = transcription.pending + transcription.deferred;
  const contextualDisabled = recordingMode === 'contextual_local' && !liveCapabilities?.capable;
  const hasRecording = Boolean(session && (session.duration_ms > 0 || (detail?.segments.length ?? 0) > 0));


  // Honest transcription progress: the only real numbers on hand are how
  // much of the recording timeline has a finished segment (detail.segments,
  // whose end_ms is real backend output) and how long the recording actually
  // is (elapsedMs, the recorder's own clock). No duration is invented for
  // chunks still pending — when we cannot compute a true ratio, the bar
  // either shows an indeterminate "working" state (if there is a real
  // backlog) or stays empty (if the queue is empty). It never fabricates a
  // number to look like a duration-based percentage.
  const transcribedThroughMs = detail?.segments.length
    ? detail.segments.reduce((max, seg) => Math.max(max, seg.end_ms), 0)
    : 0;
  const hasDurationSignal = capturing && elapsedMs > 0;
  const progressRatio = hasDurationSignal
    ? Math.min(1, transcribedThroughMs / elapsedMs)
    : null;
  const transcriptionBacklog = transcriptionPending > 0 || queue.pending > 0;
  const progressIndeterminate = progressRatio === null && transcriptionBacklog;

  return (
    <div className="recorder">
      <div className="recorder__main">
        <div className="recorder__controls">
            {!capturing && (
              <Button
                variant="live"
                icon={hasRecording ? 'play' : 'mic'}
                iconFilled
                disabled={contextualDisabled}
                title={contextualDisabled ? liveCapabilities?.detail ?? undefined : undefined}
                onClick={() => void (hasRecording ? resume() : start())}
              >
                {hasRecording ? 'Continue recording' : 'Record'}
              </Button>
            )}
            {state === 'processing' && (
              <Button variant="quiet" icon="dot" disabled>
                Processing…
              </Button>
            )}
            {state === 'recording' && (
              <Button variant="quiet" icon="pause" onClick={() => void pause()}>
                Pause
              </Button>
            )}
            {state === 'paused' && (
              <Button variant="live" icon="play" iconFilled onClick={() => void resume()}>
                Resume
              </Button>
            )}
            {capturing && (
              <Button variant="danger" icon="stop" onClick={() => void stop()}>
                Stop
              </Button>
            )}
        </div>

        <div className="recorder__status">
          <span
            className="recorder__time tabular"
            data-live={state === 'recording'}
            aria-live="off"
          >
            {formatTimecode(elapsedMs)}
          </span>
          <LevelWave meter={meter} active={state === 'recording'} />
          {state === 'recording' && <span className="recorder__badge recorder__badge--live">Live</span>}
          {state === 'paused' && <span className="recorder__badge">Paused</span>}
          {state === 'processing' && <span className="recorder__badge">Flushing audio…</span>}
          {state === 'recording' && meter.clipping && (
            <span className="recorder__badge">Clipping risk</span>
          )}
          {state === 'recording' && meter.sustainedLow && (
            <span className="recorder__badge">We can barely hear you — check your microphone</span>
          )}
          {state === 'recording' && meter.vad === 'unavailable' && (
            <span className="recorder__badge">Speech detection unavailable</span>
          )}
        </div>


      </div>

      <div className="recorder__feed-layer">
        {(failedCount > 0 || queue.overflow || transcriptionPending > 0 || transcriptionFailed > 0 || transcription.blockedByConsent || recorderError) && (
          <div className="recorder__feed">
            {queue.overflow && (
              <span className="pill pill--warn">
                <Icon name="warning" size={13} /> Capture stopped · buffered audio retained for retry
              </span>
            )}
            {failedCount > 0 && (
              <span className="pill pill--error">
                <Icon name="warning" size={13} /> {failedCount} local save{failedCount > 1 ? 's' : ''} failed
                <button className="pill__action" onClick={retry}>
                  <Icon name="retry" size={13} /> Retry
                </button>
              </span>
            )}
            {transcription.blockedByConsent && transcriptionPending > 0 && (
              <span className="pill pill--warn">
                <Icon name="warning" size={13} /> Audio saved · transcription waiting for cloud consent
              </span>
            )}
            {!transcription.blockedByConsent && transcriptionPending > 0 && (
              <span className="pill pill--info">
                <Icon name="dot" size={12} filled /> Transcription · {transcriptionPending} pending
              </span>
            )}
            {transcriptionFailed > 0 && (
              <span className="pill pill--error">
                <Icon name="warning" size={13} /> Audio saved · {transcriptionFailed} transcription request{transcriptionFailed > 1 ? 's' : ''} failed
                <button className="pill__action" onClick={retryTranscription}>
                  <Icon name="retry" size={13} /> Retry transcription
                </button>
              </span>
            )}
            {recorderError && (
              <span className="pill pill--error" role="alert">
                <Icon name="warning" size={13} /> {recorderError}
                {pendingSessionStatus && (
                  <button
                    className="pill__action"
                    onClick={() => { void retrySessionStatus(); }}
                  >
                    <Icon name="retry" size={13} /> Retry {pendingSessionStatus === 'stopped' ? 'stop' : pendingSessionStatus === 'paused' ? 'pause' : 'recording'} confirmation
                  </button>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      <div
        className="recorder__progress"
        role="progressbar"
        aria-label="Transcription progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressRatio !== null ? Math.round(progressRatio * 100) : undefined}
        data-indeterminate={progressIndeterminate}
      >
        <div
          className="recorder__progress-fill"
          style={progressRatio !== null ? { width: `${Math.round(progressRatio * 100)}%` } : undefined}
        />
      </div>
    </div>
  );
}
