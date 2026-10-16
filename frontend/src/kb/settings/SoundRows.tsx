import { useEffect, useId, useRef, useState } from 'react';
import type { MediaAccess, MediaAccessStatus } from '../../api/bridge';
import { browserDiscovery, listInputDevices } from '../../audio/devices';
import { Button, Icon, Switch } from '../ui';
import { useRecording, useServices } from '../state/context';
import { browserMicLevel } from '../recording/micLevel';
import type { RecOptions } from '../recording/recordingStore';

/**
 * Settings → Recording & speech → Sound (decision B20): the default microphone and the default
 * "Computer sound" of new recordings. Both are the recording's own options (`recordingStore`,
 * kept in the backend settings as `input_device_id` / `capture_system_audio`), so the Record button
 * uses exactly what is chosen here. Nothing here starts a recording: the microphone row only opens
 * the input for a level meter while the row is on screen.
 */

/** The recording options, read once when a row needs them (Record reads the same store). */
function useRecOptions() {
  const { recording } = useServices();
  const options = useRecording((s) => s.options);
  const loaded = useRecording((s) => s.optionsLoaded);
  useEffect(() => { if (!loaded) void recording.getState().loadOptions(); }, [loaded, recording]);
  const [error, setError] = useState<string | null>(null);
  const set = async (patch: Partial<RecOptions>) => setError(await recording.getState().setOptions(patch));
  return { options, loaded, set, error };
}

/** macOS privacy state of SKAZ (main reads `systemPreferences.getMediaAccessStatus`); null elsewhere. */
function useMediaAccess(): MediaAccess | null {
  const { bridge } = useServices();
  const [access, setAccess] = useState<MediaAccess | null>(null);
  useEffect(() => {
    let live = true;
    if (!bridge.mediaAccess) return undefined;
    const read = () => { void bridge.mediaAccess!().then((a) => { if (live) setAccess(a); }, () => undefined); };
    read();
    // Back from System Settings: the state may have changed there.
    window.addEventListener('focus', read);
    return () => { live = false; window.removeEventListener('focus', read); };
  }, [bridge]);
  return access;
}

const blocked = (status: MediaAccessStatus | undefined) => status === 'denied' || status === 'restricted';

function PrivacyButton({ pane }: { pane: 'microphone' | 'system-audio' }) {
  const { bridge } = useServices();
  const [failed, setFailed] = useState(false);
  if (!bridge.openSystemAudioSettings) return null;
  return (
    <>
      <Button size="sm" variant="outline" icon="settings"
        onClick={async () => setFailed(!(await bridge.openSystemAudioSettings!(pane).catch(() => false)))}>
        Open System Settings
      </Button>
      {failed && <span className="kb-inline-error kb-inline-error--flat" role="alert">System Settings couldn’t be opened. Open it from the Apple menu.</span>}
    </>
  );
}

/** True while the element is on screen (no IntersectionObserver, e.g. in tests: while mounted). */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [shown, setShown] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  useEffect(() => {
    const onChange = () => setShown(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible && shown;
}

type MeterState = { kind: 'off' } | { kind: 'opening' } | { kind: 'live'; level: number } | { kind: 'denied' } | { kind: 'failed'; reason: string };

/** The level of the chosen input, measured only while `active`; closed on unmount (Settings closed). */
function useMicLevel(deviceId: string, active: boolean): MeterState {
  const [state, setState] = useState<MeterState>({ kind: 'off' });
  useEffect(() => {
    if (!active || !navigator.mediaDevices?.getUserMedia) { setState({ kind: 'off' }); return undefined; }
    let live = true;
    let stop: (() => void) | null = null;
    setState({ kind: 'opening' });
    browserMicLevel.open(deviceId, (level) => { if (live) setState({ kind: 'live', level }); }).then(
      (close) => { if (live) { stop = close; setState((s) => (s.kind === 'opening' ? { kind: 'live', level: 0 } : s)); } else close(); },
      (error: unknown) => {
        if (!live) return;
        const name = (error as { name?: string } | null)?.name ?? '';
        if (name === 'NotAllowedError' || name === 'SecurityError') setState({ kind: 'denied' });
        else setState({ kind: 'failed', reason: error instanceof Error && error.message ? error.message : 'The microphone couldn’t be opened.' });
      },
    );
    return () => { live = false; stop?.(); };
  }, [deviceId, active]);
  return state;
}

function LevelMeter({ level }: { level: number }) {
  const pct = Math.round(level * 100);
  return (
    <span className="kb-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

export function MicRow() {
  const { options, set, error } = useRecOptions();
  const access = useMediaAccess();
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const ref = useRef<HTMLSpanElement | null>(null);
  const onScreen = useOnScreen(ref);
  const id = useId();
  const accessOff = blocked(access?.microphone);
  const meter = useMicLevel(options.deviceId, onScreen && !accessOff);

  useEffect(() => {
    let live = true;
    if (!navigator.mediaDevices?.enumerateDevices) { setDevices([]); return undefined; }
    listInputDevices(browserDiscovery).then((list) => { if (live) setDevices(list); }, () => { if (live) setDevices([]); });
    return () => { live = false; };
  }, []);

  const chosenMissing = options.deviceId !== '' && devices !== null && !devices.some((d) => d.deviceId === options.deviceId);
  const denied = accessOff || meter.kind === 'denied';
  return (
    <span className="kb-sound" ref={ref}>
      <label htmlFor={id} className="kb-visually-hidden">Default microphone</label>
      <span className="kb-select kb-select--grow">
        <select id={id} value={options.deviceId} onChange={(e) => void set({ deviceId: e.target.value })}>
          <option value="">System default microphone</option>
          {chosenMissing && <option value={options.deviceId}>Saved microphone (not connected)</option>}
          {(devices ?? []).map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
        </select>
        <Icon name="chevronDown" size={12} className="kb-select__chev" />
      </span>
      {denied ? (
        <>
          <span className="kb-status kb-status--err" role="status"><Icon name="error" size={13} />Microphone access is off for SKAZ</span>
          <PrivacyButton pane="microphone" />
        </>
      ) : meter.kind === 'live' ? <LevelMeter level={meter.level} />
        : meter.kind === 'failed' ? <span className="kb-inline-error kb-inline-error--flat" role="alert">{meter.reason}</span>
          : meter.kind === 'opening' ? <span className="kb-muted" role="status">Opening the microphone…</span> : null}
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
    </span>
  );
}

export function SystemAudioRow({ label }: { label: string }) {
  const { bridge } = useServices();
  const { options, set, error } = useRecOptions();
  const access = useMediaAccess();
  if (bridge.systemAudioSupported !== true) return <span className="kb-muted">Not available on this Mac</span>;
  const screen = access?.screen;
  return (
    <span className="kb-sound">
      <Switch label={label} checked={options.systemAudio} onChange={(v) => void set({ systemAudio: v })} />
      {blocked(screen) ? (
        <>
          <span className="kb-status kb-status--err" role="status"><Icon name="error" size={13} />Screen &amp; System Audio Recording is off for SKAZ</span>
          <PrivacyButton pane="system-audio" />
        </>
      ) : screen === 'granted' ? (
        <span className="kb-status kb-status--ok"><Icon name="check" size={13} />Allowed in System Settings</span>
      ) : options.systemAudio ? (
        <span className="kb-muted">macOS asks for permission the first time you record with it.</span>
      ) : null}
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
    </span>
  );
}
