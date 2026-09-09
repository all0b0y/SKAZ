import { create } from 'zustand';
import { ApiClient, ApiError } from '../api/client';
import type { BackendStatus } from '../api/bridge';
import type {
  AskResponse,
  ChatScope,
  Message,
  ModelInfo,
  Note,
  Segment,
  Session,
  SessionDetail,
  Settings,
  SettingsUpdate,
  TaskKind,
} from '../api/types';
import { AudioRecorder, type RecordedChunk, type RecorderState } from '../audio/recorder';
import { UploadQueue, type UploadQueueState } from '../audio/uploadQueue';
import { DEFAULT_WINDOW_MINUTES, type WindowPreset } from '../lib/time';

export type ThemeMode = 'system' | 'light' | 'dark';

interface DetailCache {
  segments: Segment[];
  messages: Message[];
  notes: Note | null;
}

const emptyQueueState: UploadQueueState = {
  pending: 0,
  inFlight: null,
  completed: 0,
  duplicates: 0,
  failed: [],
  droppedCount: 0,
  overflow: false,
  lastError: null,
};

export interface AppState {
  ready: boolean;
  backend: BackendStatus;

  settings: Settings | null;
  settingsError: string | null;

  sessions: Session[];
  activeSessionId: string | null;
  detail: DetailCache | null;
  detailLoading: boolean;
  detailError: string | null;

  recorderState: RecorderState;
  elapsedMs: number;
  level: number;
  queue: UploadQueueState;
  recorderError: string | null;

  devices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  permissionState: 'unknown' | 'granted' | 'denied' | 'prompt';

  chatScope: ChatScope;
  windowMinutes: WindowPreset;
  asking: boolean;
  askError: string | null;

  notesGenerating: boolean;
  notesError: string | null;

  theme: ThemeMode;

  init: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  saveSettings: (update: SettingsUpdate) => Promise<void>;
  loadModels: (provider: string, task: TaskKind) => Promise<ModelInfo[]>;

  refreshSessions: () => Promise<void>;
  newSession: (title?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;

  enumerateDevices: () => Promise<void>;
  selectDevice: (deviceId: string) => void;

  startRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  retryFailedUploads: () => void;

  ask: (question: string) => Promise<void>;
  setChatScope: (scope: ChatScope) => void;
  setWindowMinutes: (minutes: WindowPreset) => void;

  generateNotes: () => Promise<void>;

  setTheme: (theme: ThemeMode) => void;
}

// Non-reactive singletons (audio pipeline) kept outside the store snapshot.
let client: ApiClient | null = null;
let recorder: AudioRecorder | null = null;
let queue: UploadQueue | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

const getClient = (): ApiClient => {
  if (!client) client = new ApiClient(window.audiohelper);
  return client;
};

const messageId = (): string => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const mergeSegments = (existing: Segment[], incoming: Segment[]): Segment[] => {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((s) => [s.id, s]));
  for (const seg of incoming) byId.set(seg.id, seg);
  return [...byId.values()].sort((a, b) => a.start_ms - b.start_ms);
};

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  backend: { phase: 'starting' },
  settings: null,
  settingsError: null,
  sessions: [],
  activeSessionId: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  recorderState: 'idle',
  elapsedMs: 0,
  level: 0,
  queue: emptyQueueState,
  recorderError: null,
  devices: [],
  selectedDeviceId: null,
  permissionState: 'unknown',
  chatScope: 'auto',
  windowMinutes: DEFAULT_WINDOW_MINUTES,
  asking: false,
  askError: null,
  notesGenerating: false,
  notesError: null,
  theme: (localStorage.getItem('audiohelper.theme') as ThemeMode | null) ?? 'system',

  init: async () => {
    const bridge = window.audiohelper;
    set({ backend: await bridge.getBackendStatus() });
    bridge.onBackendStatus((status) => {
      set({ backend: status, ready: status.phase === 'ready' });
      if (status.phase === 'ready') {
        void get().refreshSettings();
        void get().refreshSessions();
      }
    });
    if (get().backend.phase === 'ready') {
      set({ ready: true });
      await Promise.all([get().refreshSettings(), get().refreshSessions()]);
    }
  },

  refreshSettings: async () => {
    try {
      set({ settings: await getClient().getSettings(), settingsError: null });
    } catch (err) {
      set({ settingsError: err instanceof Error ? err.message : String(err) });
    }
  },

  saveSettings: async (update) => {
    try {
      const settings = await getClient().updateSettings(update);
      set({ settings, settingsError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ settingsError: message });
      throw err;
    }
  },

  loadModels: async (provider, task) => {
    const res = await getClient().getModels(provider, task);
    if (res.error) throw new ApiError(0, res.error);
    return res.models;
  },

  refreshSessions: async () => {
    try {
      const sessions = await getClient().listSessions();
      set({ sessions });
      const { activeSessionId } = get();
      if (!activeSessionId && sessions.length > 0) {
        await get().selectSession(sessions[0]!.id);
      }
    } catch (err) {
      set({ detailError: err instanceof Error ? err.message : String(err) });
    }
  },

  newSession: async (title) => {
    if (['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    const name = title?.trim() || `Session ${new Date().toLocaleString()}`;
    const session = await getClient().createSession(name);
    set((s) => ({ sessions: [session, ...s.sessions] }));
    await get().selectSession(session.id);
  },

  selectSession: async (id) => {
    if (['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    set({
      activeSessionId: id,
      detailLoading: true,
      detailError: null,
      asking: false,
      askError: null,
      notesGenerating: false,
      notesError: null,
    });
    try {
      const detail: SessionDetail = await getClient().getSession(id);
      if (get().activeSessionId !== id) return;
      set({
        detail: { segments: detail.segments, messages: detail.messages, notes: detail.notes },
        detailLoading: false,
      });
    } catch (err) {
      if (get().activeSessionId !== id) return;
      set({ detailLoading: false, detailError: err instanceof Error ? err.message : String(err) });
    }
  },

  renameSession: async (id, title) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    const updated = await getClient().renameSession(id, title, session.status);
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? updated : x)) }));
  },

  removeSession: async (id) => {
    await getClient().deleteSession(id);
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      const wasActive = s.activeSessionId === id;
      return {
        sessions,
        activeSessionId: wasActive ? null : s.activeSessionId,
        detail: wasActive ? null : s.detail,
      };
    });
    const next = get().sessions[0];
    if (next) await get().selectSession(next.id);
  },

  enumerateDevices: async () => {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'audioinput',
      );
      set((s) => ({
        devices,
        selectedDeviceId: s.selectedDeviceId ?? devices[0]?.deviceId ?? null,
      }));
    } catch (err) {
      set({ recorderError: err instanceof Error ? err.message : String(err) });
    }
  },

  selectDevice: (deviceId) => set({ selectedDeviceId: deviceId }),

  startRecording: async () => {
    if (['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    const currentSettings = get().settings;
    if (!currentSettings) {
      set({ recorderError: 'Settings are still loading. Try recording again in a moment.' });
      return;
    }
    if (currentSettings.asr.provider !== 'local-whisper' && !currentSettings.cloud_consent) {
      set({
        recorderError: 'Cloud transcription requires consent in Settings before recording starts.',
      });
      return;
    }
    set({ recorderState: 'processing', recorderError: null });

    let { activeSessionId } = get();
    const selected = get().sessions.find((item) => item.id === activeSessionId);
    const selectedHasAudio = Boolean(
      selected?.status === 'stopped' &&
        (selected.duration_ms > 0 || (get().detail?.segments.length ?? 0) > 0),
    );
    if (!activeSessionId || selectedHasAudio) {
      // newSession is intentionally guarded while processing, so create the
      // recording session directly within this lifecycle transaction.
      const name = `Session ${new Date().toLocaleString()}`;
      try {
        const session = await getClient().createSession(name);
        set((s) => ({ sessions: [session, ...s.sessions], activeSessionId: session.id }));
        const created = await getClient().getSession(session.id);
        set({
          detail: { segments: created.segments, messages: created.messages, notes: created.notes },
        });
        activeSessionId = session.id;
      } catch (err) {
        set({
          recorderState: 'idle',
          recorderError: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    if (!activeSessionId) return;
    const sessionId = activeSessionId;

    queue = new UploadQueue({
      uploader: async (chunk) => {
        const res = await getClient().uploadAudio(
          sessionId,
          { sequence: chunk.sequence, startMs: chunk.startMs, endMs: chunk.endMs },
          chunk.wav,
        );
        if (get().activeSessionId === sessionId && res.segments.length > 0) {
          set((s) => ({
            detail: s.detail
              ? { ...s.detail, segments: mergeSegments(s.detail.segments, res.segments) }
              : s.detail,
          }));
        }
        return { duplicate: res.duplicate, segments: res.segments };
      },
      onChange: (queueState) => set({ queue: queueState }),
      onBackpressure: () => {
        set({ recorderError: 'Upload backlog reached its safe limit. Recording paused; audio is protected for retry.' });
        void get().pauseRecording();
      },
    });

    recorder = new AudioRecorder({
      onChunk: (chunk: RecordedChunk) => {
        queue?.enqueue({
          sequence: chunk.sequence,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          wav: chunk.wav,
        });
      },
      onLevel: (level) => set({ level }),
      onError: (message) => set({ recorderError: message }),
      onDisconnected: () => {
        set({ recorderError: 'Microphone disconnected. Captured audio was flushed.' });
        void get().stopRecording();
      },
    });

    try {
      await recorder.start(get().selectedDeviceId ?? undefined);
      set({ recorderState: 'recording', recorderError: null, permissionState: 'granted' });
      await getClient().setSessionStatus(sessionId, 'recording');
      void get().enumerateDevices();
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = setInterval(() => set({ elapsedMs: recorder?.elapsedMs() ?? 0 }), 250);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const denied = /denied|not allowed|permission/i.test(message);
      set({
        recorderError: denied
          ? 'Microphone access was denied. Grant permission in System Settings and try again.'
          : message,
        permissionState: denied ? 'denied' : get().permissionState,
        recorderState: 'idle',
      });
      recorder = null;
    }
  },

  pauseRecording: async () => {
    if (get().recorderState !== 'recording') return;
    set({ recorderState: 'processing', level: 0 });
    await recorder?.pause();
    await queue?.drain();
    const id = get().activeSessionId;
    if (id) await getClient().setSessionStatus(id, 'paused').catch(() => undefined);
    set({ recorderState: 'paused' });
  },

  resumeRecording: async () => {
    if (get().recorderState !== 'paused') return;
    set({ recorderState: 'processing' });
    await recorder?.resume();
    set({ recorderState: 'recording' });
    const id = get().activeSessionId;
    if (id) await getClient().setSessionStatus(id, 'recording').catch(() => undefined);
  },

  stopRecording: async () => {
    if (!['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    const id = get().activeSessionId;
    set({ recorderState: 'processing', level: 0 });
    await recorder?.stop();
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    await queue?.drain();
    if (id) {
      await getClient().setSessionStatus(id, 'stopped').catch(() => undefined);
      set({ recorderState: 'stopped', level: 0 });
      await get().selectSession(id);
      await get().refreshSessions();
    } else {
      set({ recorderState: 'stopped', level: 0 });
    }
    recorder = null;
  },

  retryFailedUploads: () => queue?.retryFailed(),

  ask: async (question) => {
    const id = get().activeSessionId;
    if (!id || !question.trim()) return;
    const userMsg: Message = {
      id: messageId(),
      role: 'user',
      content: question.trim(),
      created_at: new Date().toISOString(),
    };
    set((s) => ({
      detail: s.detail ? { ...s.detail, messages: [...s.detail.messages, userMsg] } : s.detail,
      asking: true,
      askError: null,
    }));
    try {
      const res: AskResponse = await getClient().ask(id, {
        question: question.trim(),
        scope: get().chatScope,
        window_minutes: get().windowMinutes,
      });
      const answer: Message = {
        id: messageId(),
        role: 'assistant',
        content: res.answer,
        created_at: new Date().toISOString(),
        citations: res.citations,
      };
      if (get().activeSessionId !== id) return;
      set((s) => ({
        detail: s.detail ? { ...s.detail, messages: [...s.detail.messages, answer] } : s.detail,
        asking: false,
      }));
    } catch (err) {
      if (get().activeSessionId !== id) return;
      set({ asking: false, askError: err instanceof Error ? err.message : String(err) });
    }
  },

  setChatScope: (scope) => set({ chatScope: scope }),
  setWindowMinutes: (minutes) => set({ windowMinutes: minutes }),

  generateNotes: async () => {
    const id = get().activeSessionId;
    if (!id) return;
    set({ notesGenerating: true, notesError: null });
    try {
      const notes = await getClient().generateNotes(id, get().settings?.output_language);
      if (get().activeSessionId !== id) return;
      set((s) => ({
        detail: s.detail ? { ...s.detail, notes } : s.detail,
        notesGenerating: false,
      }));
    } catch (err) {
      if (get().activeSessionId !== id) return;
      set({ notesGenerating: false, notesError: err instanceof Error ? err.message : String(err) });
    }
  },

  setTheme: (theme) => {
    localStorage.setItem('audiohelper.theme', theme);
    set({ theme });
  },
}));

// Push live capture state to main so a window close / quit can be guarded while
// audio is still recording, draining, or held for retry. One-way and cheap;
// `reportCaptureState` is optional so the bridge stub used in tests is a no-op.
let lastReported = '';
useStore.subscribe((state) => {
  const snapshot = {
    recorderState: state.recorderState,
    pending: state.queue.pending,
    failed: state.queue.failed.length,
  };
  const key = `${snapshot.recorderState}:${snapshot.pending}:${snapshot.failed}`;
  if (key === lastReported) return;
  lastReported = key;
  window.audiohelper.reportCaptureState?.(snapshot);
});
