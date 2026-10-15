import { createStore, type StoreApi } from 'zustand/vanilla';
import type { BridgeApi } from '../../api/bridge';
import type { MeterSnapshot } from '../../audio/meter';
import { errorText, KbApiError, type KbClient } from '../api/client';
import type { UiStore } from '../state/ui';
import { captureErrorText, type CaptureEngine, type CaptureFactory } from './capture';
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

export interface RecOptions {
  folderId: string | null;
  /** '' = the system default microphone. */
  deviceId: string;
  systemAudio: boolean;
  mode: RecMode;
  /** Translation target for mode "translation". */
  target: string;
}

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
  /** Why Record/Continue didn't start (shown by the capsule). */
  startError: string | null;
  /** Recognition stopped on its own; text is saved; nothing continues by itself. */
  failure: RecFailure | null;
  view: LiveView;
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

interface LegacySettings {
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
  let ticker: ReturnType<typeof setInterval> | null = null;
  let attempt = 0;

  const store = createStore<RecordingData & RecordingActions>()((set, get) => {
    const report = () => {
      const phase = get().phase;
      const pending = engine?.pending() ?? { pending: 0, failed: 0 };
      deps.bridge.reportCaptureState?.({
        recorderState: phase === 'recording' ? 'recording' : phase === 'paused' ? 'paused'
          : phase === 'idle' ? 'idle' : 'processing',
        pending: pending.pending,
        failed: pending.failed,
      });
    };
    const tick = (on: boolean) => {
      if (ticker) clearInterval(ticker);
      ticker = null;
      if (on) ticker = setInterval(() => { if (engine) set({ elapsedMs: engine.elapsedMs() }); }, 250);
    };
    const onLevel = (id: number) => (snapshot: MeterSnapshot) => {
      if (id === attempt && get().phase === 'recording') set({ bars: barsFrom(snapshot) });
    };
    const onFailure = (id: number) => (message: string) => {
      if (id !== attempt || !isLive(get().phase)) return;
      void fail(message);
    };

    /** Recognition/capture stopped on its own: keep what is saved, settle, never continue alone. */
    const fail = async (message: string) => {
      const materialId = get().materialId;
      const atMs = engine?.elapsedMs() ?? get().elapsedMs;
      attempt += 1;
      tick(false);
      set({ phase: 'finishing', bars: SILENT_BARS });
      await engine?.stop().catch(() => false);
      engine = null;
      if (materialId) await settle(materialId, 'stop');
      set({ phase: 'idle', failure: materialId ? { materialId, atMs, message } : null, elapsedMs: atMs });
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
      failure: null,
      view: 'original',

      loadOptions: async () => {
        const [defaults, settings] = await Promise.allSettled([
          deps.client.call('GET /kb/recordings/defaults'),
          deps.bridge.request<LegacySettings>({ method: 'GET', path: '/settings' }),
        ]);
        const patch: Partial<RecOptions> = {};
        if (defaults.status === 'fulfilled' && get().options.folderId === null) patch.folderId = defaults.value.folder_id;
        if (settings.status === 'fulfilled' && settings.value.ok) {
          const s = settings.value.data;
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
        set({ phase: 'starting', startError: null, failure: null, chatId: null, chatError: null, elapsedMs: 0, bars: SILENT_BARS });
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
          set({ phase: 'idle', startError: materialId ? captureErrorText(error) : errorText(error), bars: SILENT_BARS });
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
        set({ phase: 'resuming', startError: null });
        try {
          await deps.client.call('POST /kb/recordings/{material_id}/resume', { path: { material_id: materialId } });
          await engine.resume(sources());
          set({ phase: 'recording' });
          tick(true);
        } catch (error) {
          set({ phase: 'paused', startError: captureErrorText(error) });
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
        const saved = await (current?.stop() ?? Promise.resolve(true)).catch(() => false);
        if (!saved) {
          // Unsaved audio: keep the quit guard (main warns before closing) and say so.
          set({ startError: 'Some audio isn’t saved yet. SKAZ keeps it and will not quit silently.' });
          report();
          return false;
        }
        engine = null;
        await settle(materialId, 'stop');
        // The capture graph never confirmed its last flush: what arrived is saved, the final
        // moment may be missing. The quit guard hears it, so SKAZ never quits over it silently.
        const complete = !(current?.incomplete?.() ?? false);
        set({
          phase: 'idle', bars: SILENT_BARS,
          ...(complete ? {} : { startError: 'The last moment of audio before stopping couldn’t be confirmed. Everything received is saved.' }),
        });
        report();
        deps.onMaterialsChanged?.();
        return complete;
      },

      continueRecording: async (materialId) => {
        if (get().phase !== 'idle') return;
        const failure = get().failure;
        const kept = failure && failure.materialId === materialId ? failure : null;
        set({ phase: 'starting', startError: null, failure: null, elapsedMs: 0, bars: SILENT_BARS });
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
          set({ phase: 'idle', failure: kept, startError: resumed ? captureErrorText(error) : errorText(error), bars: SILENT_BARS });
          report();
        }
      },

      continueAfterFailure: async () => {
        const failure = get().failure;
        if (failure) await get().continueRecording(failure.materialId);
      },

      setView: (view) => set({ view }),
      clearStartError: () => set({ startError: null }),

      prepareQuit: async () => {
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
