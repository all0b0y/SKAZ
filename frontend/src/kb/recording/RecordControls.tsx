import { useEffect, useRef, useState, type RefObject } from 'react';
import { listInputDevices, browserDiscovery } from '../../audio/devices';
import { Button, Icon, Popover, Segmented, Spinner, Switch, useIconPlayHold } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { formatTime } from '../library/materialMeta';
import { NameField } from '../library/NameField';
import { languageName } from '../material/MaterialView';
import { useLibrary, useRecording, useServices, useUi } from '../state/context';
import { isLive, type LiveView, type RecErrorWhen, type RecOptions } from './recordingStore';
import { speechServiceName } from './connection';
import { SpeechBars } from '../fx/indicators/SpeechBars';

const TARGETS = ['en', 'ru', 'de', 'fr', 'es', 'it', 'pt', 'uk', 'zh', 'ja'];
const VIEW_OPTIONS: ReadonlyArray<{ value: LiveView; label: string }> = [
  { value: 'original', label: 'Original' },
  { value: 'translation', label: 'Translation' },
  { value: 'both', label: 'Both' },
];

function Bars() {
  const bars = useRecording((s) => s.bars);
  // Heights follow the real signal only; silence = short, still bars. Drawn on change, no loop, no CSS animation.
  return <SpeechBars levels={bars} />;
}

/** "Record | Folder ▾" menu: folder, microphone, computer sound, mode, language (v12, v15). */
function RecordMenu({ onStart, close }: { onStart: () => void; close: () => void }) {
  const { recording, library, bridge } = useServices();
  const folders = useLibrary((s) => s.folders);
  const options = useRecording((s) => s.options);
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = bridge.systemAudioSupported === true;

  useEffect(() => {
    let live = true;
    if (!navigator.mediaDevices?.enumerateDevices) { setDevices([]); return undefined; }
    listInputDevices(browserDiscovery).then((list) => { if (live) setDevices(list); }, () => { if (live) setDevices([]); });
    return () => { live = false; };
  }, []);

  const set = async (patch: Partial<RecOptions>) => {
    setError(await recording.getState().setOptions(patch));
  };

  return (
    <div className="kb-recmenu">
      <p className="kb-recmenu__head">Folder</p>
      <div role="radiogroup" aria-label="Folder for the recording" className="kb-recmenu__list">
        {folders.map((f) => (
          <button key={f.id} type="button" role="radio" aria-checked={options.folderId === f.id}
            className={`kb-menu__item${options.folderId === f.id ? ' is-on' : ''}`}
            onClick={() => void set({ folderId: f.id })}>
            <Icon name={f.system ? 'inbox' : 'folder'} size={14} />
            <span className="kb-menu__label">{f.name}</span>
            {options.folderId === f.id && <Icon name="check" size={14} />}
          </button>
        ))}
        {creating ? (
          <NameField label="New folder name" placeholder="Folder name"
            onSubmit={async (name) => {
              const result = await library.getState().createFolder(name);
              if (result.ok) void set({ folderId: result.value.id });
              return result;
            }}
            onDone={() => setCreating(false)} />
        ) : (
          <button type="button" className="kb-menu__item" onClick={() => setCreating(true)}>
            <Icon name="folderPlus" size={14} /><span className="kb-menu__label">New folder…</span>
          </button>
        )}
      </div>
      <p className="kb-recmenu__head">Sound</p>
      <label className="kb-recmenu__row">
        <Icon name="mic" size={14} />
        <span className="kb-visually-hidden">Microphone</span>
        <span className="kb-select kb-select--grow">
          <select value={options.deviceId} onChange={(e) => void set({ deviceId: e.target.value })} aria-label="Microphone">
            <option value="">System default microphone</option>
            {(devices ?? []).map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
          </select>
          <Icon name="chevronDown" size={12} className="kb-select__chev" />
        </span>
      </label>
      <div className="kb-recmenu__row">
        <Icon name="system" size={14} />
        <span className="kb-recmenu__label">Computer sound</span>
        {supported ? (
          <Switch label="Computer sound" checked={options.systemAudio} onChange={(v) => void set({ systemAudio: v })} />
        ) : (
          <span className="kb-recmenu__note">Not available on this Mac</span>
        )}
      </div>
      <p className="kb-recmenu__head">Mode</p>
      <div className="kb-recmenu__seg">
        <Segmented label="Recording mode" size="sm" value={options.mode}
          options={[{ value: 'transcription', label: 'Transcription' }, { value: 'translation', label: '+ translation' }]}
          onChange={(mode) => void set({ mode })} />
      </div>
      {options.mode === 'translation' && (
        <label className="kb-recmenu__row">
          <span className="kb-recmenu__label">Translate into</span>
          <span className="kb-select">
            <select value={options.target} onChange={(e) => void set({ target: e.target.value })} aria-label="Translate into">
              {TARGETS.map((t) => <option key={t} value={t}>{languageName(t)}</option>)}
            </select>
            <Icon name="chevronDown" size={12} className="kb-select__chev" />
          </span>
        </label>
      )}
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
      <div className="kb-recmenu__go">
        <Button variant="fill" icon="mic" onClick={() => { close(); onStart(); }}>Start recording</Button>
      </div>
    </div>
  );
}

/** The error window's title: what didn't happen, in this situation. */
const ERROR_TITLE: Record<RecErrorWhen, string> = {
  start: 'Recording didn’t start',
  resume: 'Recording didn’t resume',
  continue: 'Recording didn’t continue',
  'stop-unsaved': 'Some audio isn’t saved yet',
  'stop-unconfirmed': 'The end of the recording isn’t confirmed',
};

/**
 * Why Record / Resume / Continue didn't work, or what a Stop couldn't confirm. A capture permission
 * problem offers the fixed System Settings pane that fixes it (macOS; the old "Open System Settings").
 */
function StartErrorPopover({ anchorRef }: { anchorRef: RefObject<HTMLButtonElement | null> }) {
  const { recording, bridge } = useServices();
  const startError = useRecording((s) => s.startError);
  const when = useRecording((s) => s.startErrorWhen);
  const permission = useRecording((s) => s.startPermission);
  const [opened, setOpened] = useState<boolean | null>(null);
  useEffect(() => { setOpened(null); }, [startError]);
  const close = () => recording.getState().clearStartError();
  const title = ERROR_TITLE[when ?? 'start'];
  return (
    <Popover open={startError !== null} onClose={close} anchorRef={anchorRef}
      label={title} placement="bottom-end" autoFocus={false} width={300}>
      <div className="kb-recerr" role="alert">
        <Icon name="warning" size={16} />
        <div className="kb-recerr__body">
          <p className="kb-recerr__title">{title}</p>
          <p>{startError}</p>
        </div>
        <div className="kb-recerr__actions">
          {permission && bridge.openSystemAudioSettings && (
            <Button size="sm" variant="outline" icon="settings"
              onClick={async () => setOpened(await bridge.openSystemAudioSettings!(permission).catch(() => false))}>
              Open System Settings
            </Button>
          )}
          <Button size="sm" variant="quiet" onClick={close}>OK</Button>
        </div>
        {opened === false && <p className="kb-inline-error kb-inline-error--flat">System Settings couldn’t be opened. Open it from the Apple menu.</p>}
      </div>
    </Popover>
  );
}

/** Title-bar recording control: "Record | Folder ▾" → capsule "▮▮▮ 12:41 | Folder" (decisions 26–28). */
export function RecordControls() {
  const { recording } = useServices();
  const phase = useRecording((s) => s.phase);
  const elapsed = useRecording((s) => s.elapsedMs);
  const options = useRecording((s) => s.options);
  const loaded = useRecording((s) => s.optionsLoaded);
  const view = useRecording((s) => s.view);
  const materialId = useRecording((s) => s.materialId);
  const stream = useRecording((s) => s.stream);
  const provider = useRecording((s) => s.provider);
  const folders = useLibrary((s) => s.folders);
  const library = useLibrary((s) => s.library);
  const openLive = useUi((s) => s.openLive);
  const right = useUi((s) => s.right);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rowOpen, setRowOpen] = useState(false);
  // Feedback motion (animated-icons spec): the mic moves when a recording starts; the spinner waits for it.
  const mic = useIconPlayHold();
  // The control row's truth for event handlers: a hover and a click can arrive before React
  // re-renders, so handlers read these refs, never the `rowOpen` of their render.
  const rowOpenNow = useRef(false);
  const rowByHover = useRef(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const setRow = (open: boolean, byHover = false) => {
    rowOpenNow.current = open;
    rowByHover.current = open && byHover;
    setRowOpen(open);
  };
  const recordRef = useRef<HTMLButtonElement | null>(null);
  const folderRef = useRef<HTMLButtonElement | null>(null);
  const capsuleRef = useRef<HTMLButtonElement | null>(null);
  const ready = library?.state === 'ready';

  useEffect(() => { if (ready && !loaded) void recording.getState().loadOptions(); }, [ready, loaded, recording]);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const folderName = folders.find((f) => f.id === options.folderId)?.name ?? folders.find((f) => f.system)?.name ?? 'Inbox';
  const start = () => { void recording.getState().start(); };
  const startFromButton = () => { mic.replay(); start(); };

  const live = isLive(phase);
  const paused = phase === 'paused' || phase === 'pausing';
  const reconnecting = phase === 'recording' && stream === 'reconnecting';
  // A recording that ends (Stop, failure) leaves no row behind for the next one.
  useEffect(() => {
    if (!live) { window.clearTimeout(hoverTimer.current); rowOpenNow.current = false; rowByHover.current = false; setRowOpen(false); }
  }, [live]);

  if (phase === 'finishing') {
    return (
      <span className="kb-pill kb-pill--status" role="status" data-testid="record-capsule">
        <Spinner label="Finishing transcript" size="sm" />Finishing transcript…
      </span>
    );
  }

  if (live) {
    const hoverOpen = () => { window.clearTimeout(hoverTimer.current); if (!rowOpenNow.current) setRow(true, true); };
    const hoverClose = () => {
      window.clearTimeout(hoverTimer.current);
      if (rowByHover.current) hoverTimer.current = window.setTimeout(() => { if (rowByHover.current) setRow(false); }, 350);
    };
    return (
      <span className="kb-capwrap" onMouseEnter={hoverOpen} onMouseLeave={hoverClose} data-testid="record-capsule">
        <button
          ref={capsuleRef}
          type="button"
          className={`kb-cap${paused ? ' kb-cap--paused' : ' kb-cap--rec'}${rowOpen ? ' is-open' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={rowOpen}
          aria-label={`${paused ? 'Paused' : 'Recording'} ${formatTime(elapsed)}, folder ${folderName}${reconnecting ? `, reconnecting to ${speechServiceName(provider)}` : ''}. Recording controls`}
          onClick={() => {
            window.clearTimeout(hoverTimer.current);
            // Opened by hovering: a click pins it open instead of closing it under the pointer.
            if (rowOpenNow.current && rowByHover.current) { rowByHover.current = false; return; }
            setRow(!rowOpenNow.current);
          }}
        >
          {paused ? <span className="kb-pzd" aria-hidden="true" /> : <Bars />}
          <b className="kb-cap__time">{formatTime(elapsed)}</b>
          <span className="kb-capsule__div" aria-hidden="true" />
          <span className={`kb-cap__folder${reconnecting ? ' kb-cap__folder--warn' : ''}`}>{paused ? 'Paused' : reconnecting ? 'Reconnecting…' : folderName}</span>
          <Icon name="chevronDown" size={12} className={rowOpen ? 'kb-rot' : undefined} />
        </button>
        {paused && (
          <Button size="sm" variant="outline" icon="play" className="kb-cap__resume" disabled={phase !== 'paused'}
            onClick={() => void recording.getState().resume()}>Resume</Button>
        )}
        <StartErrorPopover anchorRef={capsuleRef} />
        <Popover open={rowOpen} onClose={() => setRow(false)} anchorRef={capsuleRef} label="Recording controls"
          placement="bottom-end" className="kb-capctl" autoFocus={!rowByHover.current}>
          <div className="kb-capctl__row" onMouseEnter={hoverOpen} onMouseLeave={hoverClose}>
            {paused ? (
              <button type="button" className="kb-cbtn" aria-label="Resume" disabled={phase !== 'paused'}
                onClick={() => void recording.getState().resume()}><Icon name="play" size={14} /></button>
            ) : (
              <button type="button" className="kb-cbtn" aria-label="Pause" disabled={phase !== 'recording'}
                onClick={() => void recording.getState().pause()}><Icon name="pause" size={14} /></button>
            )}
            <button type="button" className="kb-cbtn kb-cbtn--stop" aria-label="Stop"
              onClick={() => { setRow(false); void recording.getState().stop(); }}><Icon name="stop" size={14} /></button>
            <span className="kb-capctl__sep" aria-hidden="true" />
            <Segmented label="Show" size="sm" value={view} options={VIEW_OPTIONS} onChange={(v) => recording.getState().setView(v)} />
            {materialId && right?.kind !== 'live' && (
              <button type="button" className="kb-cbtn" aria-label="Show live transcript" onClick={() => openLive(materialId)}>
                <Icon name="text" size={14} />
              </button>
            )}
          </div>
        </Popover>
      </span>
    );
  }

  const disabledReason = !ready ? 'Connect the library first' : null;
  return (
    <span className="kb-recgo" data-testid="record-capsule">
      <Tooltip text={disabledReason ?? `Record into ${folderName}`} describes>
        <button ref={recordRef} type="button" className="kb-capsule kb-capsule--go" aria-disabled={!ready || phase === 'starting' || undefined}
          onClick={() => { if (ready && phase === 'idle') startFromButton(); }}>
          {phase === 'starting' && !mic.held
            ? <span className="kb-spinner kb-spinner--inline kb-spinner--onfill" aria-hidden="true" />
            : <Icon name="mic" size={14} play={mic.play} />}
          <span className="kb-capsule__main">Record</span>
        </button>
      </Tooltip>
      <button ref={folderRef} type="button" className="kb-capsule kb-capsule--folder" aria-haspopup="dialog" aria-expanded={menuOpen}
        aria-label={`Recording folder and sound: ${folderName}`} aria-disabled={!ready || undefined}
        onClick={() => { if (ready) setMenuOpen((v) => !v); }}>
        <span className="kb-capsule__folder">{folderName}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={folderRef} label="Recording settings"
        placement="bottom-end" className="kb-recmenu-pop" width={300}>
        <RecordMenu onStart={start} close={() => setMenuOpen(false)} />
      </Popover>
      <StartErrorPopover anchorRef={recordRef} />
    </span>
  );
}
