import { useEffect } from 'react';
import { useStore } from '../../state/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { formatTimecode } from '../../lib/time';

function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const bars = 5;
  return (
    <div className="meter" role="img" aria-label={`Input level ${Math.round(level * 100)}%`}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className="meter__bar"
          data-on={active && level * bars > i}
          style={{ height: `${30 + i * 16}%` }}
        />
      ))}
    </div>
  );
}

export function RecorderBar() {
  const state = useStore((s) => s.recorderState);
  const elapsedMs = useStore((s) => s.elapsedMs);
  const level = useStore((s) => s.level);
  const queue = useStore((s) => s.queue);
  const devices = useStore((s) => s.devices);
  const selectedDeviceId = useStore((s) => s.selectedDeviceId);
  const recorderError = useStore((s) => s.recorderError);
  const enumerateDevices = useStore((s) => s.enumerateDevices);
  const selectDevice = useStore((s) => s.selectDevice);
  const start = useStore((s) => s.startRecording);
  const pause = useStore((s) => s.pauseRecording);
  const resume = useStore((s) => s.resumeRecording);
  const stop = useStore((s) => s.stopRecording);
  const retry = useStore((s) => s.retryFailedUploads);

  useEffect(() => {
    void enumerateDevices();
  }, [enumerateDevices]);

  const capturing = state === 'recording' || state === 'paused' || state === 'processing';
  const failedCount = queue.failed.length;

  return (
    <div className="recorder">
      <div className="recorder__main">
        <div className="recorder__controls">
          {!capturing && (
            <Button variant="live" icon="mic" iconFilled onClick={() => void start()}>
              Record
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
          <LevelMeter level={level} active={state === 'recording'} />
          {state === 'recording' && <span className="recorder__badge recorder__badge--live">Live</span>}
          {state === 'paused' && <span className="recorder__badge">Paused</span>}
          {state === 'processing' && <span className="recorder__badge">Flushing audio…</span>}
        </div>

        <label className="recorder__device">
          <span className="visually-hidden">Microphone</span>
          <Icon name="mic" size={15} />
          <select
            value={selectedDeviceId ?? ''}
            onChange={(e) => selectDevice(e.target.value)}
            disabled={capturing}
          >
            {devices.length === 0 && <option value="">Default microphone</option>}
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {(queue.pending > 0 || failedCount > 0 || queue.overflow || recorderError) && (
        <div className="recorder__feed">
          {queue.pending > 0 && (
            <span className="pill pill--info">
              <Icon name="dot" size={12} filled /> Uploading · {queue.pending} pending
            </span>
          )}
          {queue.overflow && (
            <span className="pill pill--warn">
              <Icon name="warning" size={13} /> Recording paused · audio protected for retry
            </span>
          )}
          {failedCount > 0 && (
            <span className="pill pill--error">
              <Icon name="warning" size={13} /> {failedCount} upload{failedCount > 1 ? 's' : ''} failed
              <button className="pill__action" onClick={retry}>
                <Icon name="retry" size={13} /> Retry
              </button>
            </span>
          )}
          {recorderError && (
            <span className="pill pill--error" role="alert">
              <Icon name="warning" size={13} /> {recorderError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
