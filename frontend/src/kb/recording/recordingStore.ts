import { createStore, type StoreApi } from 'zustand/vanilla';
import type { BridgeApi } from '../../api/bridge';
import type { KbFragment, KbRecordingLive } from '../../api/kb/types.gen';
import type { MeterSnapshot } from '../../audio/meter';
import { errorText, KbApiError, type KbClient } from '../api/client';
import type { UiStore } from '../state/ui';
import { captureErrorText, capturePermission, type CaptureEngine, type CaptureFactory, type PrivacyPane } from './capture';
import { barsFrom, SILENT_BARS, type Bars } from './level';

/**
 * Recording in the new interface (decisions 26–28).
 * `Record` → POST /kb/recordings (material + session) → POST /kb/chats {recording_material_id}
 * (a new chat about the recording, C1) → the live panel opens on the right → the existing capture
 * pipeline streams to the session. Pause/Resume/Stop end the stream first, then settle the
 * material over /kb/recordings/{id}/pause|resume|stop. Nothing blinks: the capsule shows three
 * bars from the real signal and a red timer.
 */

export type RecPhase = 'idle' | 'starting' | 'recording' | 'pausing' | 'paused' | 'resuming' | 'finishing';
export type LiveView = 'original' | 'translation' | 'both';
export type RecMode = 'transcription' | 'translation';
/** The recording's live stream as the backend reports it (`stream` of `GET /kb/recordings/{id}/live`). */
export type StreamState = 'connecting' | 'reconnecting' | 'streaming' | 'unavailable' | 'inactive' | 'disabled';
const STREAM_STATES: ReadonlyArray<StreamState> = ['connecting', 'reconnecting', 'streaming', 'unavailable', 'inactive', 'disabled'];

export interface RecOptions {
  folderId: string | null;
  /** '' = the system default microphone. */
  deviceId: string;
  systemAudio: boolean;
  mode: RecMode;
  /** Translation target for mode "translation". */
  target: string;
}

/** What the capsule's error window is about: each has its own title (RecordControls). */
export type RecErrorWhen = 'start' | 'resume' | 'continue' | 'stop-unsaved' | 'stop-unconfirmed';

export interface RecFailure {
  materialId: string;
  /** Recording time at which recognition stopped. */
  atMs: number;
  message: string;
}

export interface RecordingData {
  phase: RecPhase;
  materialId: string | null;
  sessionId: string | null;
  title: string | null;
  /** The chat opened for this recording (POST /kb/chats); U2 shows it. */
  chatId: string | null;
  chatError: string | null;
  elapsedMs: number;
  bars: Bars;
  options: RecOptions;
  optionsLoaded: boolean;
  /** Why Record/Resume/Continue didn't work, or what a Stop couldn't confirm (shown by the capsule). */
  startError: string | null;
  /** Which of those it is (the window's title); null with no error. */
  startErrorWhen: RecErrorWhen | null;
  /** The macOS privacy setting that fixes `startError` (microphone / screen & system audio), if any. */
  startPermission: PrivacyPane | null;
  /** Recognition stopped on its own; text is saved; nothing continues by itself. */
  failure: RecFailure | null;
  view: LiveView;
  /** Stream state while recording (null when not streaming); polled with the live text. */
  stream: StreamState | null;
  /** The speech service of new recordings (legacy `transcription_provider`): `soniox`, `local-whisper`, … */
  provider: string | null;
  /**
   * The last answer of `GET /kb/recordings/{id}/live`: speech after the material's fragments — the
   * open monologue's final words and the words still being recognised. Kept after Pause/Stop until
   * the next recording, so the panel can hand the text over to the material without a gap.
   */
  live: KbRecordingLive | null;
  /**
   * Fragments the material gained while recording (`fragments` of the live answers, asked with
   * `since_seg`): the panels append them instead of re-reading the whole material every poll.
   */
  liveFragments: KbFragment[];
}

export interface RecordingActions {
  loadOptions: () => Promise<void>;
  setOptions: (patch: Partial<RecOptions>) => Promise<string | null>;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<boolean>;
  /** Continue a paused/stopped recording into the same material and session (also after a restart). */
  continueRecording: (materialId: string) => Promise<void>;
  continueAfterFailure: () => Promise<void>;
  setView: (view: LiveView) => void;
  clearStartError: () => void;
  /** Quit barrier: stop a running recording and report whether its audio is saved. */
  prepareQuit: () => Promise<boolean>;
}

export type RecordingStore = StoreApi<RecordingData & RecordingActions>;

type RecBridge = Pick<BridgeApi, 'request'> & Partial<Pick<BridgeApi, 'reportCaptureState'>>;

interface Deps {
  client: KbClient;
  bridge: RecBridge;
  ui: UiStore;
  capture: CaptureFactory | null;
  /** Library refresh after a new material appears. */
  onMaterialsChanged?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

const LIVE_STATES: ReadonlyArray<RecPhase> = ['recording', 'pausing', 'paused', 'resuming'];
const SETTLE_TRIES = 60;
const STREAM_POLL_MS = 1500;
/** Background retries of audio that couldn't be saved when a recording stopped (~2 minutes). */
const SAVE_RETRIES = 24;
const SAVE_RETRY_MS = 5000;

/** "the last 3 s", "the last 2 min 5 s" — how much recording time a message says was lost. */
function spoken(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ''}`;
}

interface LegacySettings {
  transcription_provider?: string;
  native_recording_mode?: string;
  translation_target_language?: string;
  input_device_id?: string | null;
  capture_system_audio?: boolean;
}

export function isLive(phase: RecPhase): boolean {
  return LIVE_STATES.includes(phase);
}

export function createRecordingStore(deps: Deps): RecordingStore {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let engine: CaptureEngine | null = null;
  /**
   * A stopped capture whose audio isn't all saved yet. It stays referenced so the quit guard keeps
   * counting its unsaved audio, and SKAZ keeps retrying it in the background.
   */
  let unsaved: CaptureEngine | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let poller: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever polling starts or stops: an answer of an older loop never schedules another. */
  let pollLoop = 0;
  let attempt = 0;

  const store = createStore<RecordingData & RecordingActions>()((set, get) => {
    const report = () => {
      const phase = get().phase;
      const live = engine?.pending() ?? { pending: 0, failed: 0 };
      const kept = unsaved?.pending() ?? { pending: 0, failed: 0 };
      const pending = { pending: live.pending + kept.pending, failed: live.failed + kept.failed };
      deps.bridge.reportCaptureState?.({
        recorderState: phase === 'recording' ? 'recording' : phase === 'paused' ? 'paused'
          : phase === 'idle' ? 'idle' : 'processing',
        pending: pending.pending,
        failed: pending.failed,
      });
    };
    /**
     * The live text after the material's fragments, the fragments added since the last answer and
     * the stream state, in one small answer — never the whole material.
     */
    const pollStream = async () => {
      const materialId = get().materialId;
      if (get().phase !== 'recording' || !materialId) return;
      const previous = get().live;
      const since = previous && previous.material_id === materialId ? previous.after_seg : null;
      try {
        const live = await deps.client.call('GET /kb/recordings/{material_id}/live', {
          path: { material_id: materialId }, ...(since !== null ? { query: { since_seg: since } } : {}),
        });
        if (get().phase !== 'recording' || get().materialId !== materialId) return;
        const known = get().liveFragments;
        const last = known.at(-1)?.seg ?? since ?? 0;
        const added = (live.fragments ?? []).filter((f) => f.seg > last);
        set({
          stream: STREAM_STATES.find((s) => s === live.stream) ?? null, live,
          ...(added.length ? { liveFragments: [...known, ...added] } : {}),
        });
      } catch {
        // A missed poll changes nothing on screen; the next one (1.5 s) catches up.
      }
    };
    /** One poll at a time: the next starts STREAM_POLL_MS after the previous answered. */
    const pollUntilStopped = async (loop: number) => {
      poller = null;
      await pollStream();
      if (loop === pollLoop) poller = setTimeout(() => { void pollUntilStopped(loop); }, STREAM_POLL_MS);
    };
    const tick = (on: boolean) => {
      if (ticker) clearInterval(ticker);
      if (poller) clearTimeout(poller);
      ticker = null;
      poller = null;
      pollLoop += 1;
      if (on) {
        ticker = setInterval(() => { if (engine) set({ elapsedMs: engine.elapsedMs() }); }, 250);
        void pollUntilStopped(pollLoop);
      } else {
        set({ stream: null });
      }
    };
    const onLevel = (id: number) => (snapshot: MeterSnapshot) => {
      if (id === attempt && get().phase === 'recording') set({ bars: barsFrom(snapshot) });
    };
    const onFailure = (id: number) => (message: string) => {
      if (id !== attempt || !isLive(get().phase)) return;
      void fail(message);
    };

    /**
     * Keep retrying a stopped capture's unsaved audio in the background. The quit guard counts it
     * all along (report), so SKAZ never quits over it silently; once saved, the material settles.
     */
    const keepSaving = (current: CaptureEngine, materialId: string | null) => {
      unsaved = current;
      report();
      void (async () => {
        for (let i = 0; i < SAVE_RETRIES && unsaved === current; i += 1) {
          await sleep(SAVE_RETRY_MS);
          if (unsaved !== current) return;
          if (await (current.retry?.() ?? Promise.resolve(false)).catch(() => false)) {
            unsaved = null;
            break;
          }
        }
        // Saved, or out of retries: the material settles with what the backend has. Audio still
        // unsaved stays counted for the quit guard until SKAZ quits.
        if (materialId) await settle(materialId, 'stop');
        report();
        deps.onMaterialsChanged?.();
      })();
    };

    /** What a stop that couldn't save everything says: what is lost for good, what is still kept. */
    const unsavedText = (current: CaptureEngine | null, saved: boolean): string | null => {
      const lost = current?.lostMs?.() ?? 0;
      if (lost > 0) {
        return `The last ${spoken(lost)} of audio couldn’t be saved and are lost.`
          + (saved ? '' : ' SKAZ keeps the rest of the unsaved audio and keeps trying to save it.');
      }
      return saved ? null : 'Some audio isn’t saved yet. SKAZ keeps it, keeps trying to save it, and will not quit silently.';
    };

    /** Recognition/capture stopped on its own: keep what is saved, settle, never continue alone. */
    const fail = async (message: string) => {
      const materialId = get().materialId;
      const atMs = engine?.elapsedMs() ?? get().elapsedMs;
      attempt += 1;
      tick(false);
      set({ phase: 'finishing', bars: SILENT_BARS });
      const current = engine;
      const saved = await (current?.stop() ?? Promise.resolve(true)).catch(() => false);
      engine = null;
      // Unsaved audio must stay visible to the quit guard: report it before anything settles. The
      // stream stays open for the retries; keepSaving settles the material afterwards.
      if (!saved && current) keepSaving(current, materialId);
      else if (materialId) await settle(materialId, 'stop');
      const loss = unsavedText(current, saved);
      set({
        phase: 'idle', elapsedMs: atMs,
        failure: materialId ? { materialId, atMs, message: loss ? `${message} ${loss}` : message } : null,
      });
      report();
    };

    /** POST /kb/recordings/{id}/stop|pause until the backend has the stream ended (409 = still streaming). */
    const settle = async (materialId: string, action: 'stop' | 'pause') => {
      for (let i = 0; i < SETTLE_TRIES; i += 1) {
        try {
          const view = await deps.client.call(action === 'stop' ? 'POST /kb/recordings/{material_id}/stop' : 'POST /kb/recordings/{material_id}/pause',
            { path: { material_id: materialId } });
          if (action === 'pause' || (view.recording_state !== 'processing' && view.status !== 'processing')) return;
        } catch (error) {
          if (!(error instanceof KbApiError && error.status === 409)) return;
        }
        await sleep(1000);
      }
    };

    const sources = () => {
      const o = get().options;
      return { ...(o.deviceId ? { deviceId: o.deviceId } : {}), systemAudio: o.systemAudio };
    };

    const begin = async (sessionId: string, sampleRate?: number) => {
      if (!deps.capture) throw new Error('Recording isn’t available in this window.');
      const id = ++attempt;
      engine = deps.capture();
      await engine.start({ sessionId, sources: sources(), sampleRate }, { onLevel: onLevel(id), onFailure: onFailure(id) });
      if (id !== attempt) return;
      set({ phase: 'recording', elapsedMs: engine.elapsedMs() });
      tick(true);
      report();
    };

    return {
      phase: 'idle',
      materialId: null,
      sessionId: null,
      title: null,
      chatId: null,
      chatError: null,
      elapsedMs: 0,
      bars: SILENT_BARS,
      options: { folderId: null, deviceId: '', systemAudio: false, mode: 'transcription', target: 'en' },
      optionsLoaded: false,
      startError: null,
      startErrorWhen: null,
      startPermission: null,
      failure: null,
      view: 'original',
      stream: null,
      provider: null,
      live: null,
      liveFragments: [],

      loadOptions: async () => {
        const [defaults, settings] = await Promise.allSettled([
          deps.client.call('GET /kb/recordings/defaults'),
          deps.bridge.request<LegacySettings>({ method: 'GET', path: '/settings' }),
        ]);
        const patch: Partial<RecOptions> = {};
        if (defaults.status === 'fulfilled' && get().options.folderId === null) patch.folderId = defaults.value.folder_id;
        if (settings.status === 'fulfilled' && settings.value.ok) {
          const s = settings.value.data;
          if (s.transcription_provider) set({ provider: s.transcription_provider });
          patch.mode = s.native_recording_mode === 'translation' ? 'translation' : 'transcription';
          patch.target = s.translation_target_language || 'en';
          patch.deviceId = s.input_device_id ?? '';
          patch.systemAudio = s.capture_system_audio === true;
        }
        set((st) => ({ options: { ...st.options, ...patch }, optionsLoaded: true }));
      },

      setOptions: async (patch) => {
        const before = get().options;
        set({ options: { ...before, ...patch } });
        const update: Record<string, unknown> = {};
        if (patch.mode !== undefined) update.native_recording_mode = patch.mode;
        if (patch.target !== undefined) update.translation_target_language = patch.target;
        if (patch.deviceId !== undefined) update.input_device_id = patch.deviceId;
        if (patch.systemAudio !== undefined) update.capture_system_audio = patch.systemAudio;
        const materialId = get().materialId;
        try {
          if (Object.keys(update).length) {
            const res = await deps.bridge.request({ method: 'PUT', path: '/settings', body: update });
            if (!res.ok) throw new KbApiError(res.status, res.detail);
          }
          // Decision 16: the folder can change during a recording too — the material moves.
          if (patch.folderId && materialId && isLive(get().phase)) {
            await deps.client.call('PATCH /kb/materials/{material_id}', { path: { material_id: materialId }, body: { folder_id: patch.folderId } });
            deps.onMaterialsChanged?.();
          }
          return null;
        } catch (error) {
          set({ options: before });
          return errorText(error);
        }
      },

      start: async () => {
        if (get().phase !== 'idle') return;
        set({ phase: 'starting', startError: null, startErrorWhen: null, startPermission: null, failure: null, chatId: null, chatError: null, elapsedMs: 0, bars: SILENT_BARS, live: null, liveFragments: [] });
        report();
        let materialId: string | null = null;
        try {
          const speech = await deps.client.call('POST /kb/recordings', { body: { folder_id: get().options.folderId } });
          materialId = speech.material_id;
          set({
            materialId, sessionId: speech.session_id, title: speech.title,
            view: get().options.mode === 'translation' ? 'translation' : 'original',
            options: { ...get().options, folderId: speech.folder_id },
          });
          deps.onMaterialsChanged?.();
          deps.ui.getState().openLive(materialId);
          // A new chat about this recording; the recording works even if the chat can't open.
          void deps.client.call('POST /kb/chats', { body: { recording_material_id: materialId } }).then(
            (chat) => { if (get().materialId === materialId) set({ chatId: chat.id }); },
            (error: unknown) => { if (get().materialId === materialId) set({ chatError: errorText(error) }); },
          );
          await begin(speech.session_id);
        } catch (error) {
          tick(false);
          attempt += 1;
          await engine?.stop().catch(() => false);
          engine = null;
          if (materialId) await settle(materialId, 'stop');
          set({
            phase: 'idle', startError: materialId ? captureErrorText(error) : errorText(error), startErrorWhen: 'start',
            startPermission: materialId ? capturePermission(error) : null, bars: SILENT_BARS,
          });
          report();
        }
      },

      pause: async () => {
        const { phase, materialId } = get();
        if (phase !== 'recording' || !engine || !materialId) return;
        set({ phase: 'pausing', bars: SILENT_BARS });
        tick(false);
        try {
          await engine.pause();
          await settle(materialId, 'pause');
          set({ phase: 'paused', elapsedMs: engine.elapsedMs() });
        } catch (error) {
          await fail(captureErrorText(error));
          return;
        }
        report();
      },

      resume: async () => {
        const { phase, materialId } = get();
        if (phase !== 'paused' || !engine || !materialId) return;
        set({ phase: 'resuming', startError: null, startErrorWhen: null, startPermission: null });
        try {
          await deps.client.call('POST /kb/recordings/{material_id}/resume', { path: { material_id: materialId } });
          await engine.resume(sources());
          set({ phase: 'recording' });
          tick(true);
          void pollStream();
        } catch (error) {
          set({ phase: 'paused', startError: captureErrorText(error), startErrorWhen: 'resume', startPermission: capturePermission(error) });
        }
        report();
      },

      stop: async () => {
        const { phase, materialId } = get();
        if (!isLive(phase) || !materialId) return true;
        attempt += 1;
        tick(false);
        set({ phase: 'finishing', bars: SILENT_BARS });
        report();
        const current = engine;
        let saved = await (current?.stop() ?? Promise.resolve(true)).catch(() => false);
        // One immediate retry: a delivery that failed once often goes through after reconnecting.
        if (!saved && current?.retry) saved = await current.retry().catch(() => false);
        if (!saved) {
          // Unsaved audio: keep it for the quit guard (main warns before closing), keep retrying
          // in the background, and say so.
          engine = null;
          if (current) keepSaving(current, materialId);
          set({ phase: 'idle', startError: unsavedText(current, false), startErrorWhen: 'stop-unsaved' });
          report();
          return false;
        }
        engine = null;
        await settle(materialId, 'stop');
        const lost = unsavedText(current, true);
        if (lost) {
          set({ phase: 'idle', bars: SILENT_BARS, startError: lost, startErrorWhen: 'stop-unsaved' });
          report();
          deps.onMaterialsChanged?.();
          return false;
        }
        // The capture graph never confirmed its last flush: what arrived is saved, the final
        // moment may be missing. The quit guard hears it, so SKAZ never quits over it silently.
        const complete = !(current?.incomplete?.() ?? false);
        set({
          phase: 'idle', bars: SILENT_BARS,
          ...(complete ? {} : {
            startError: 'The last moment of audio before stopping couldn’t be confirmed. Everything received is saved.',
            startErrorWhen: 'stop-unconfirmed' as const,
          }),
        });
        report();
        deps.onMaterialsChanged?.();
        return complete;
      },

      continueRecording: async (materialId) => {
        if (get().phase !== 'idle') return;
        const failure = get().failure;
        const kept = failure && failure.materialId === materialId ? failure : null;
        set({ phase: 'starting', startError: null, startErrorWhen: null, startPermission: null, failure: null, elapsedMs: 0, bars: SILENT_BARS, live: null, liveFragments: [] });
        report();
        let resumed = false;
        try {
          // The backend checks the material is a recording that may continue (not running, not finishing).
          const speech = await deps.client.call('POST /kb/recordings/{material_id}/resume', { path: { material_id: materialId } });
          resumed = true;
          const live = await deps.bridge.request<{ sample_rate?: number; recording_mode?: string }>({
            method: 'GET', path: `/sessions/${encodeURIComponent(speech.session_id)}/live`,
          });
          const translation = live.ok && live.data.recording_mode === 'translation';
          set({
            materialId, sessionId: speech.session_id, title: speech.title,
            chatId: get().materialId === materialId ? get().chatId : null,
            view: translation ? 'translation' : 'original',
            options: { ...get().options, folderId: speech.folder_id },
          });
          deps.ui.getState().openLive(materialId);
          // The session keeps its PCM clock: capture continues at the sample rate it started with.
          await begin(speech.session_id, live.ok ? live.data.sample_rate : undefined);
        } catch (error) {
          tick(false);
          attempt += 1;
          await engine?.stop().catch(() => false);
          engine = null;
          if (resumed) await settle(materialId, 'stop');
          set({
            phase: 'idle', failure: kept, startError: resumed ? captureErrorText(error) : errorText(error), startErrorWhen: 'continue',
            startPermission: resumed ? capturePermission(error) : null, bars: SILENT_BARS,
          });
          report();
        }
      },

      continueAfterFailure: async () => {
        const failure = get().failure;
        if (failure) await get().continueRecording(failure.materialId);
      },

      setView: (view) => set({ view }),
      clearStartError: () => set({ startError: null, startErrorWhen: null, startPermission: null }),

      prepareQuit: async () => {
        if (unsaved) {
          const current = unsaved;
          if (await (current.retry?.() ?? Promise.resolve(false)).catch(() => false)) {
            unsaved = null;
            report();
          } else {
            return false;
          }
        }
        if (get().phase === 'idle') return true;
        if (get().phase === 'starting' || get().phase === 'finishing') {
          for (let i = 0; i < SETTLE_TRIES && !['idle', 'recording', 'paused'].includes(get().phase); i += 1) await sleep(250);
        }
        return isLive(get().phase) ? get().stop() : get().phase === 'idle';
      },
    };
  });
  return store;
}
