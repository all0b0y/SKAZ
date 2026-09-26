import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { captureSourcesLocked } from '../../state/captureSources';
import { ApiClient } from '../../api/client';
import type { NativeRecordingMode, SettingsUpdate } from '../../api/types';
import { usePanePlacement } from '../../hooks/usePanePlacement';
import { claimOpenMenu } from '../../lib/openMenu';
import { byShownName, languageName } from '../settings/UsedLanguages';
import { Icon } from '../ui/Icon';

const UNSUPPORTED = 'System audio requires macOS 14.2 or later';
const LOCKED = 'Locked while recording';

/**
 * The capsule's source controls (.dev/docs/CAPTURE-SOURCES-BULK-SPEC.md §2):
 * a one-click system-audio toggle and a gear with the recording preferences.
 * Both write the same persisted settings Settings shows, immediately.
 */
export function RecorderSources({ hasRecording }: { hasRecording: boolean }) {
  const settings = useStore((s) => s.settings);
  const recorderState = useStore((s) => s.recorderState);
  const setCaptureSystemAudio = useStore((s) => s.setCaptureSystemAudio);
  const [open, setOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);
  const locked = captureSourcesLocked(recorderState);
  const supported = window.audiohelper?.systemAudioSupported === true;
  const systemOn = settings?.capture_system_audio === true;
  const toggleBlocked = locked || !supported || !settings;
  const toggleTitle = !supported ? UNSUPPORTED : locked ? LOCKED
    : systemOn ? 'System audio is included — click to record the microphone only' : 'Include system audio';

  return (
    <div className="capsule__sources">
      <button type="button" className={clsx('capsule__source', systemOn && supported && 'capsule__source--on')}
        aria-label="Include system audio" aria-pressed={systemOn && supported} aria-disabled={toggleBlocked || undefined}
        title={toggleTitle}
        onClick={() => { if (!toggleBlocked) void setCaptureSystemAudio(!systemOn).catch(() => undefined); }}>
        <Icon name="monitor" size={16} />
      </button>
      <button ref={gearRef} type="button" className="capsule__source" aria-label="Recording settings" title="Recording settings"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="settings" size={16} />
      </button>
      {open && <SourcesPopover anchor={gearRef} hasRecording={hasRecording} onClose={() => setOpen(false)} />}
    </div>
  );
}

function SourcesPopover({ anchor, hasRecording, onClose }: {
  anchor: React.RefObject<HTMLButtonElement>; hasRecording: boolean; onClose: () => void;
}) {
  const settings = useStore((s) => s.settings);
  const devices = useStore((s) => s.devices);
  const selectedDeviceId = useStore((s) => s.selectedDeviceId);
  const recorderState = useStore((s) => s.recorderState);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const selectDevice = useStore((s) => s.selectDevice);
  const setCaptureSystemAudio = useStore((s) => s.setCaptureSystemAudio);
  const saveSettings = useStore((s) => s.saveSettings);
  const enumerateDevices = useStore((s) => s.enumerateDevices);
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  // A session that already has a recording keeps its mode; show that, not the next-session default.
  const [sessionMode, setSessionMode] = useState<{ mode: NativeRecordingMode; target: string } | null>(null);
  const locked = captureSourcesLocked(recorderState);
  const modeFixed = hasRecording || locked || recorderState === 'paused';
  const supported = window.audiohelper?.systemAudioSupported === true;
  usePanePlacement(ref, () => anchor.current?.getBoundingClientRect() ?? null, { align: 'end', boundsFrom: anchor }, []);

  useEffect(() => { void enumerateDevices(); }, [enumerateDevices]);
  useEffect(() => {
    if (!modeFixed || !activeSessionId) { setSessionMode(null); return undefined; }
    let alive = true;
    void new ApiClient(window.audiohelper).getNativeEventPage(activeSessionId, { limit: 1 })
      .then((page) => { if (alive) setSessionMode({ mode: page.recording_mode, target: page.translation_target_language }); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [modeFixed, activeSessionId]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('select:not(:disabled), input:not(:disabled)')?.focus();
    const release = claimOpenMenu(() => onClose());
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      release();
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
      if (previous?.isConnected) previous.focus();
    };
  }, [anchor, onClose]);

  const apply = (run: () => Promise<void>) => {
    setError('');
    // The store rolls its own state back; the control re-renders from it.
    void run().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const saveOne = (update: SettingsUpdate) => apply(() => saveSettings(update));

  const nextMode = settings?.native_recording_mode === 'translation' ? 'translation' : 'transcription';
  const mode = modeFixed ? (sessionMode?.mode === 'translation' ? 'translation' : sessionMode ? 'transcription' : nextMode) : nextMode;
  const target = modeFixed && sessionMode ? sessionMode.target : settings?.translation_target_language ?? 'ru';
  const deviceKnown = !selectedDeviceId || devices.some((d) => d.deviceId === selectedDeviceId);

  return createPortal(
    <div ref={ref} className="sources-popover" role="dialog" aria-label="Recording settings">
      <label className="sources-popover__field">Microphone
        <select value={deviceKnown ? selectedDeviceId ?? '' : ''} disabled={locked}
          onChange={(e) => apply(() => selectDevice(e.target.value))}>
          {(devices.length === 0 || !deviceKnown) && <option value="">Default microphone</option>}
          {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
        </select>
      </label>
      {!deviceKnown && <p className="sources-popover__hint">Saved microphone is not connected — recording uses the default one.</p>}
      <label className="sources-popover__check">
        <input type="checkbox" checked={settings?.capture_system_audio === true && supported}
          disabled={locked || !supported} onChange={(e) => apply(() => setCaptureSystemAudio(e.target.checked))} />
        Include system audio
      </label>
      <p className="sources-popover__hint">{supported ? 'Use headphones to avoid echo.' : `${UNSUPPORTED}.`}</p>
      <label className="sources-popover__field">Mode
        <select value={mode} disabled={modeFixed}
          onChange={(e) => saveOne({ native_recording_mode: e.target.value as NativeRecordingMode })}>
          <option value="transcription">Transcription</option>
          <option value="translation">Transcription and translation</option>
        </select>
      </label>
      {mode === 'translation' && <label className="sources-popover__field">Translate to
        <select value={target} disabled={modeFixed}
          onChange={(e) => saveOne({ translation_target_language: e.target.value })}>
          {byShownName([target, ...(settings?.supported_languages ?? [])]).map((code) =>
            <option key={code} value={code}>{languageName(code)}</option>)}
        </select>
      </label>}
      {locked ? <p className="sources-popover__hint">{LOCKED}.</p>
        : modeFixed && <p className="sources-popover__hint">Fixed for this session. New sessions use Settings.</p>}
      {error && <p role="alert" className="sources-popover__error">{error}</p>}
    </div>,
    document.body,
  );
}
