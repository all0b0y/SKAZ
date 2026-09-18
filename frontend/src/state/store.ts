import { create } from 'zustand';
import { defaultSessionTitle } from '../lib/time';
import { ApiClient, ApiError } from '../api/client';
import type { BackendStatus, BridgeApi } from '../api/bridge';
import type {
  AskResponse,
  ChatScope,
  Citation,
  LocalModelStatus,
  LocalProviderName,
  LiveAsrCapabilities,
  LiveAsrDraft,
  LiveAsrFragment,
  LiveAsrResumeCompatibility,
  LiveAsrSchedulerStatus,
  LiveAsrSourceIntegrity,
  Message,
  ModelInfo,
  Note,
  NoteDetail,
  Segment,
  Session,
  SessionDetail,
  SessionMode,
  SessionStatus,
  Settings,
  SettingsUpdate,
  TaskKind,
} from '../api/types';
import { AudioRecorder, type RecordedChunk, type RecorderState } from '../audio/recorder';
import { SignalMeter, idleMeterSnapshot, type MeterSnapshot } from '../audio/meter';
import { PersistenceQueue, type PersistenceQueueState } from '../audio/persistenceQueue';
import { NativeAudioWriter } from '../audio/nativeWriter';
import { ContextualSchedulerNotifier } from '../audio/contextualScheduler';
import type { TranscriptionQueueState } from '../audio/transcriptionQueue';
import { DEFAULT_WINDOW_MINUTES, type WindowPreset } from '../lib/time';

export type ThemeMode = 'system' | 'light' | 'dark';

// A client-side note of intent: "the operator switched recognition language
// here." Not a claim that the backend re-recognized anything before this
// point — purely a marker for reading the transcript back later.
export interface LanguageMark {
  atMs: number;
  language: string;
}

/**
 * A quote pulled from the notes into the chat composer. `citation` is present
 * only when citationMatch actually resolved the fragment to a transcript
 * segment — we never invent a timecode we could not verify.
 */
export interface AskContext {
  text: string;
  citation: Citation | null;
}

interface DetailCache {
  segments: Segment[];
  messages: Message[];
  notes: Note | null;
  notes_list?: Note[];
}

const emptyQueueState: PersistenceQueueState = {
  pending: 0,
  inFlight: null,
  completed: 0,
  duplicates: 0,
  failed: [],
  droppedCount: 0,
  overflow: false,
  lastError: null,
};

const emptyTranscriptionState: TranscriptionQueueState = {
  pending: 0,
  inFlight: null,
  completed: 0,
  failed: [],
  deferred: 0,
  diskFailed: 0,
  blockedByConsent: false,
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

  quitRequested: boolean;
  /** Sticky for this application run: another recording cannot repair an unknown tail. */
  captureIncomplete: boolean;
  prepareForQuit: () => Promise<boolean>;
  cancelQuit: () => void;
  recorderState: RecorderState;
  elapsedMs: number;
  level: number;
  meter: MeterSnapshot;
  queue: PersistenceQueueState;
  transcription: TranscriptionQueueState;
  recorderError: string | null;
  nextRecordingMode: SessionMode;
  liveCapabilities: LiveAsrCapabilities | null;
  liveDraft: LiveAsrDraft | null;
  liveFragments: LiveAsrFragment[];
  liveSourceIntegrity: LiveAsrSourceIntegrity | null;
  liveResumeCompatibility: LiveAsrResumeCompatibility | null;
  liveScheduler: LiveAsrSchedulerStatus | null;
  liveError: string | null;
  pendingSessionStatus: SessionStatus | null;
  pendingSessionStatusSessionId: string | null;
  languageMarks: LanguageMark[];

  devices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  permissionState: 'unknown' | 'granted' | 'denied' | 'prompt';

  chatScope: ChatScope;
  /**
   * A fragment lifted out of the notes and parked above the chat composer.
   * It is *context*, not a question: the user still types what they want to
   * know about it. Cleared on send, on dismissal, and on session switch.
   */
  askContext: AskContext | null;
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
  prepareLocalModel: (provider: LocalProviderName, model: string) => Promise<LocalModelStatus>;
  localModelStatus: (provider: LocalProviderName, model: string) => Promise<LocalModelStatus>;
  deleteLocalModel: (provider: LocalProviderName, model: string) => Promise<LocalModelStatus>;
  refreshLiveCapabilities: () => Promise<void>;
  setNextRecordingMode: (mode: SessionMode) => void;
  changeTranscriptLanguage: (language: string) => Promise<void>;
  refreshContextualLive: (sessionId: string) => Promise<void>;
  resumeContextualProcessing: () => Promise<void>;
  editLiveFragment: (
    fragmentId: string,
    text: string,
    expectedRevision: number,
    rangeFingerprint: string,
  ) => Promise<void>;
  acceptLiveFragment: (
    fragmentId: string,
    expectedRevision: number,
    rangeFingerprint: string,
  ) => Promise<void>;

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
  retrySessionStatus: () => Promise<void>;
  retryFailedUploads: () => void;
  retryFailedTranscriptions: () => void;

  ask: (question: string) => Promise<void>;
  setChatScope: (scope: ChatScope) => void;
  setAskContext: (context: AskContext | null) => void;
  setWindowMinutes: (minutes: WindowPreset) => void;

  /** Generation always produces a new note; it never overwrites open text. */
  generateNotes: (detail?: NoteDetail) => Promise<Note | null>;
  createEmptyNote: () => Promise<Note | null>;
  /** Rename without touching the document; a blank name is refused by the caller. */
  renameNote: (note: Note, title: string) => Promise<Note | null>;
  /** Soft deletion: the note leaves the list but its row waits for the trash. */
  deleteNote: (noteId: string) => Promise<boolean>;
  /**
   * Re-read the stored transcript of the active session.
   *
   * Finals can land after Stop, and nothing else refreshes `detail.segments`
   * while the user sits on the Notes tab — without this, generation stays
   * disabled with "Нет транскрипции" over a session that has one.
   */
  refreshTranscriptSource: () => Promise<void>;

  setTheme: (theme: ThemeMode) => void;
}

// Non-reactive singletons (audio pipeline) kept outside the store snapshot.
let client: ApiClient | null = null;
let recorder: AudioRecorder | null = null;
let persistenceQueue: PersistenceQueue | null = null;
let nativeWriter: NativeAudioWriter | null = null;
let nativeFailureCleanup: (() => void) | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let signalMeter: SignalMeter | null = null;
let stopRequested = false;
let contextualNotifier: ContextualSchedulerNotifier | null = null;
let contextualNotifierSessionId: string | null = null;
let liveSelectionGeneration = 0;
let recordingSessionId: string | null = null;
let sessionStatusIntentGeneration = 0;
let sessionStatusFlight: Promise<void> = Promise.resolve();
let liveRefreshInFlight: Promise<void> | null = null;
let liveRefreshSessionId: string | null = null;
let liveRefreshGeneration: number | null = null;

interface SessionStatusIntent {
  generation: number;
  sessionId: string;
  status: SessionStatus;
}

// The bridge object is fixed for the life of a real window, but it is rebound
// between tests. Caching the client without checking identity would keep calling
// a bridge the window no longer has — silently, and only in tests, which is the
// worst place for a stale reference to hide.
let clientBridge: BridgeApi | null = null;
const getClient = (): ApiClient => {
  if (!client || clientBridge !== window.audiohelper) {
    client = new ApiClient(window.audiohelper);
    clientBridge = window.audiohelper;
  }
  return client;
};

const messageId = (): string => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const reconcileImmutableFinals = (existing: Segment[], incoming: Segment[]): Segment[] => {
  const byId = new Map(existing.map((segment) => [segment.id, segment]));
  for (const segment of incoming) {
    if (!byId.has(segment.id)) byId.set(segment.id, segment);
  }
  return [...byId.values()].sort((a, b) => a.start_ms - b.start_ms);
};

export const useStore = create<AppState>((set, get) => {
  const sessionMode = (sessionId: string): SessionMode => (
    get().sessions.find((item) => item.id === sessionId)?.mode ?? 'legacy'
  );

  const ensureContextualNotifier = (sessionId: string): ContextualSchedulerNotifier => {
    if (contextualNotifier && contextualNotifierSessionId === sessionId) return contextualNotifier;
    contextualNotifierSessionId = sessionId;
    contextualNotifier = new ContextualSchedulerNotifier(async (sequence) => {
      try {
        const response = await getClient().advanceLiveAsr(sessionId, sequence);
        if (get().activeSessionId === sessionId) {
          set({ liveScheduler: response.scheduler, liveError: null });
        }
      } catch (error) {
        if (get().activeSessionId === sessionId) {
          set({ liveError: error instanceof Error ? error.message : String(error) });
        }
        throw error;
      }
    });
    return contextualNotifier;
  };

  const acknowledgeSessionStatus = async (
    sessionId: string,
    status: SessionStatus,
    options: { clearErrorOnSuccess?: boolean } = {},
    intent: SessionStatusIntent = {
      generation: ++sessionStatusIntentGeneration,
      sessionId,
      status,
    },
  ): Promise<boolean> => {
    const current = () => (
      intent.generation === sessionStatusIntentGeneration
      && intent.sessionId === sessionId
      && intent.status === status
    );
    let acknowledged = false;
    const request = async () => {
      if (!current()) return;
      try {
        const writer = nativeWriter?.sessionId === sessionId ? nativeWriter : null;
        if (writer && status !== 'recording') await writer.finish(status === 'paused' ? 'pause' : 'stop');
        // stream.opened/stream.stopped are already durable lifecycle ACKs.
        // A later read-model refresh must not invalidate a successful Stop.
        const updated = writer
          ? null
          : await getClient().setSessionStatus(sessionId, status,
            status === 'paused' || status === 'stopped' ? { flush_transcription: false } : {});
        if (!current()) return;
        if (writer && status === 'stopped' && nativeWriter === writer) {
          nativeFailureCleanup?.();
          nativeFailureCleanup = null;
        }
        set((state) => ({
          sessions: state.sessions.map((item) => (item.id === sessionId ? updated ?? { ...item, status } : item)),
          pendingSessionStatus: state.pendingSessionStatusSessionId === sessionId
            ? null
            : state.pendingSessionStatus,
          pendingSessionStatusSessionId: state.pendingSessionStatusSessionId === sessionId
            ? null
            : state.pendingSessionStatusSessionId,
          recorderError: options.clearErrorOnSuccess ? null : state.recorderError,
        }));
        acknowledged = true;
      } catch (error) {
        if (!current()) return;
        const detail = error instanceof Error ? error.message : String(error);
        set({
          pendingSessionStatus: status,
          pendingSessionStatusSessionId: sessionId,
          recorderError: `Backend ${status} confirmation failed: ${detail}`,
        });
      }
    };
    const queued = sessionStatusFlight.then(request, request);
    sessionStatusFlight = queued.then(() => undefined, () => undefined);
    await queued;
    return acknowledged;
  };

  const beginSessionStatusIntent = (
    sessionId: string,
    status: SessionStatus,
  ): SessionStatusIntent => ({
    generation: ++sessionStatusIntentGeneration,
    sessionId,
    status,
  });

  return ({
  ready: false,
  backend: { phase: 'starting' },
  settings: null,
  settingsError: null,
  sessions: [],
  activeSessionId: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  quitRequested: false,
  captureIncomplete: false,
  prepareForQuit: async () => {
    set({ quitRequested: true });
    try {
      await get().stopRecording();
      const saved = await persistenceQueue?.drain() ?? true;
      const state = get();
      return saved && !state.captureIncomplete && ['idle', 'stopped'].includes(state.recorderState)
        && state.queue.pending === 0 && state.queue.failed.length === 0
        && state.pendingSessionStatus === null;
    } catch (error) {
      set({ recorderError: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },
  cancelQuit: () => set({ quitRequested: false }),
  recorderState: 'idle',
  elapsedMs: 0,
  level: 0,
  meter: idleMeterSnapshot(),
  queue: emptyQueueState,
  transcription: emptyTranscriptionState,
  recorderError: null,
  nextRecordingMode: 'legacy',
  liveCapabilities: null,
  liveDraft: null,
  liveFragments: [],
  liveSourceIntegrity: null,
  liveResumeCompatibility: null,
  liveScheduler: null,
  liveError: null,
  pendingSessionStatus: null,
  pendingSessionStatusSessionId: null,
  languageMarks: [],
  devices: [],
  selectedDeviceId: null,
  permissionState: 'unknown',
  chatScope: 'auto',
  askContext: null,
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
        void get().refreshLiveCapabilities();
      }
    });
    if (get().backend.phase === 'ready') {
      set({ ready: true });
      await Promise.all([
        get().refreshSettings(), get().refreshSessions(), get().refreshLiveCapabilities(),
      ]);
    }
  },

  refreshSettings: async () => {
    try {
      const settings = await getClient().getSettings();
      set({ settings, settingsError: null });
    } catch (err) {
      set({ settingsError: err instanceof Error ? err.message : String(err) });
    }
  },

  saveSettings: async (update) => {
    try {
      const settings = await getClient().updateSettings(update);
      set({ settings, settingsError: null });
      await get().refreshLiveCapabilities();
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

  // Explicit local-checkpoint download. Never call this on mount/selection/save —
  // only from a user click. The status GET is safe to poll (see .runtime contract).
  prepareLocalModel: (provider, model) => getClient().prepareLocalModel(provider, model),
  localModelStatus: (provider, model) => getClient().getLocalModelStatus(provider, model),
  deleteLocalModel: (provider, model) => getClient().deleteLocalModel(provider, model),

  refreshLiveCapabilities: async () => {
    try {
      const liveCapabilities = await getClient().getLiveAsrCapabilities();
      set({ liveCapabilities });
    } catch (error) {
      set({
        liveCapabilities: null,
        liveError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  setNextRecordingMode: (mode) => {
    if (['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    set({ nextRecordingMode: mode, recorderError: null });
  },

  changeTranscriptLanguage: async (language) => {
    const capturingNow = ['recording', 'paused', 'processing'].includes(get().recorderState);
    const atMs = get().elapsedMs;
    await get().saveSettings({ transcript_language: language });
    if (!capturingNow) return;
    // Client-side intent marker only: records that the operator chose this
    // language at this point in the recording timeline. Nothing is sent to
    // the backend and no prior text is claimed to have been re-recognized.
    set((state) => {
      const last = state.languageMarks[state.languageMarks.length - 1];
      if (last && last.language === language) return {};
      return { languageMarks: [...state.languageMarks, { atMs, language }] };
    });
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
    if (get().quitRequested) return;
    if (['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    const name = title?.trim() || defaultSessionTitle();
    const mode = get().nextRecordingMode;
    if (mode === 'contextual_local' && !get().liveCapabilities?.capable) {
      set({ recorderError: get().liveCapabilities?.detail ?? 'Contextual local recording capability is unavailable.' });
      return;
    }
    const session = await getClient().createSession(name, mode);
    set((s) => ({ sessions: [session, ...s.sessions], languageMarks: [] }));
    await get().selectSession(session.id);
  },

  selectSession: async (id) => {
    if (['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    const generation = ++liveSelectionGeneration;
    set((s) => ({
      activeSessionId: id,
      detailLoading: true,
      detailError: null,
      asking: false,
      askError: null,
      // Scope is sticky within a session but must not leak into the next one:
      // someone returning to a different session later expects "auto", not
      // whatever window/scope they last left on the previous session.
      chatScope: s.activeSessionId === id ? s.chatScope : 'auto',
      // A quoted notes fragment belongs to the session it came from.
      askContext: s.activeSessionId === id ? s.askContext : null,
      notesGenerating: false,
      notesError: null,
      liveDraft: null,
      liveFragments: [],
      liveSourceIntegrity: null,
      liveResumeCompatibility: null,
      liveScheduler: null,
      liveError: null,
      // Language marks belong to a single recording session's timeline;
      // reloading the same session (e.g. right after stopping) must keep
      // them, but switching to a different session starts a clean slate.
      languageMarks: s.activeSessionId === id ? s.languageMarks : [],
    }));
    try {
      const detail: SessionDetail = await getClient().getSession(id);
      if (get().activeSessionId !== id || generation !== liveSelectionGeneration) return;
      set({
        detail: { segments: detail.segments, messages: detail.messages, notes: detail.notes, notes_list: detail.notes_list },
        detailLoading: false,
      });
      if (detail.session.mode === 'contextual_local') void get().refreshContextualLive(id);
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
    if (get().activeSessionId === id) liveSelectionGeneration += 1;
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      const wasActive = s.activeSessionId === id;
      return {
        sessions,
        activeSessionId: wasActive ? null : s.activeSessionId,
        detail: wasActive ? null : s.detail,
        liveDraft: wasActive ? null : s.liveDraft,
        liveFragments: wasActive ? [] : s.liveFragments,
        liveSourceIntegrity: wasActive ? null : s.liveSourceIntegrity,
        liveResumeCompatibility: wasActive ? null : s.liveResumeCompatibility,
        liveScheduler: wasActive ? null : s.liveScheduler,
        pendingSessionStatus: s.pendingSessionStatusSessionId === id
          ? null
          : s.pendingSessionStatus,
        pendingSessionStatusSessionId: s.pendingSessionStatusSessionId === id
          ? null
          : s.pendingSessionStatusSessionId,
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

  refreshContextualLive: async (sessionId) => {
    if (sessionMode(sessionId) !== 'contextual_local') return;
    const generation = liveSelectionGeneration;
    if (
      liveRefreshInFlight
      && liveRefreshSessionId === sessionId
      && liveRefreshGeneration === generation
    ) {
      await liveRefreshInFlight;
      return;
    }
    const refresh = (async () => {
      const failures: string[] = [];
      const isCurrent = () => (
        get().activeSessionId === sessionId && generation === liveSelectionGeneration
      );
      const liveRequest = getClient().getLiveAsr(sessionId).then((live) => {
        if (!isCurrent()) return;
        set({
          liveDraft: live.draft,
          liveSourceIntegrity: live.source_integrity ?? null,
          liveResumeCompatibility: live.resume_compatibility ?? null,
        });
      }).catch((error) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
      const schedulerRequest = getClient().getLiveAsrScheduler(sessionId).then((scheduler) => {
        if (isCurrent()) set({ liveScheduler: scheduler });
      }).catch((error) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
      const fragmentsRequest = getClient().getLiveAsrFragments(sessionId).then((fragments) => {
        if (isCurrent()) set({ liveFragments: fragments });
      }).catch((error) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
      const detailRequest = getClient().getSession(sessionId).then((detail) => {
        if (!isCurrent()) return;
        set((state) => ({
          detail: state.detail
            ? {
                ...state.detail,
                segments: reconcileImmutableFinals(state.detail.segments, detail.segments),
              }
            : state.detail,
        }));
      }).catch((error) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
      await Promise.all([liveRequest, schedulerRequest, fragmentsRequest, detailRequest]);
      if (!isCurrent()) return;
      set({ liveError: failures.length > 0 ? failures.join(' ') : null });
    })();
    liveRefreshSessionId = sessionId;
    liveRefreshGeneration = generation;
    liveRefreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (liveRefreshInFlight === refresh) {
        liveRefreshInFlight = null;
        liveRefreshSessionId = null;
        liveRefreshGeneration = null;
      }
    }
  },

  resumeContextualProcessing: async () => {
    const sessionId = get().activeSessionId;
    if (!sessionId || sessionMode(sessionId) !== 'contextual_local') return;
    const generation = liveSelectionGeneration;
    const isCurrent = () => (
      get().activeSessionId === sessionId && generation === liveSelectionGeneration
    );
    if (!get().liveCapabilities?.capable) {
      set({ liveError: get().liveCapabilities?.detail ?? 'Contextual local recording capability is unavailable.' });
      return;
    }
    try {
      let cursor: number | undefined;
      let latest: number | null = null;
      let complete = false;
      for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
        const page = await getClient().getAudioManifestPage(sessionId, cursor, 100);
        if (!isCurrent()) return;
        for (const chunk of page.chunks) {
          if (chunk.available) latest = Math.max(latest ?? chunk.sequence, chunk.sequence);
        }
        if (page.next_after_sequence === null) {
          complete = true;
          break;
        }
        if (cursor !== undefined && page.next_after_sequence <= cursor) {
          throw new Error('Saved-audio manifest returned a repeated cursor.');
        }
        cursor = page.next_after_sequence;
      }
      if (!isCurrent()) return;
      if (!complete) throw new Error('Saved-audio manifest exceeded its page limit.');
      if (latest === null) {
        set({ liveError: 'No stored audio is available to resume.' });
        return;
      }
      if (!isCurrent()) return;
      ensureContextualNotifier(sessionId).retry(latest);
    } catch (error) {
      if (!isCurrent()) return;
      set({ liveError: error instanceof Error ? error.message : String(error) });
    }
  },

  editLiveFragment: async (fragmentId, text, expectedRevision, rangeFingerprint) => {
    const sessionId = get().activeSessionId;
    const fragment = get().liveFragments.find((item) => item.fragment_id === fragmentId);
    const generation = liveSelectionGeneration;
    if (!sessionId || !fragment || !text.trim()) return;
    try {
      const updated = await getClient().editLiveAsrFragment(sessionId, fragmentId, {
        text: text.trim(),
        expected_revision: expectedRevision,
        range_fingerprint: rangeFingerprint,
      });
      if (get().activeSessionId !== sessionId || generation !== liveSelectionGeneration) return;
      set((state) => ({
        liveFragments: state.liveFragments.map((item) => (
          item.fragment_id === fragmentId ? updated : item
        )),
        liveError: null,
      }));
    } catch (error) {
      if (get().activeSessionId === sessionId && generation === liveSelectionGeneration) {
        set({ liveError: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  },

  acceptLiveFragment: async (fragmentId, expectedRevision, rangeFingerprint) => {
    const sessionId = get().activeSessionId;
    const fragment = get().liveFragments.find((item) => item.fragment_id === fragmentId);
    const generation = liveSelectionGeneration;
    if (!sessionId || !fragment) return;
    const idempotencyKey = `accept-${fragmentId}-${expectedRevision}-${Date.now()}`;
    try {
      const updated = await getClient().acceptLiveAsrFragment(sessionId, fragmentId, {
        expected_revision: expectedRevision,
        range_fingerprint: rangeFingerprint,
        idempotency_key: idempotencyKey,
      });
      if (get().activeSessionId !== sessionId || generation !== liveSelectionGeneration) return;
      set((state) => ({
        liveFragments: state.liveFragments.map((item) => (
          item.fragment_id === fragmentId ? updated : item
        )),
        liveError: null,
      }));
    } catch (error) {
      if (get().activeSessionId === sessionId && generation === liveSelectionGeneration) {
        set({ liveError: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  },

  startRecording: async () => {
    if (get().quitRequested) return;
    if (['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    if (get().pendingSessionStatus) {
      set({ recorderError: 'Confirm the previous backend lifecycle state before recording again.' });
      return;
    }
    if (get().queue.pending > 0 || get().queue.failed.length > 0) {
      set({ recorderError: 'Unsaved audio is still protected. Retry local saving before starting another recording.' });
      return;
    }
    const currentSettings = get().settings;
    if (!currentSettings) {
      set({ recorderError: 'Settings are still loading. Try recording again in a moment.' });
      return;
    }
    // Compatibility mode describes archived data, not a choice of live ASR writer.
    if (!currentSettings.used_languages?.length) {
      set({ recorderError: 'Перед первой записью выберите используемые языки в Settings → System.' });
      return;
    }
    const recordingMode: SessionMode = 'legacy';
    // Local persistence is allowed without cloud consent. The independent ASR
    // scheduler enforces consent before it fetches or submits persisted bytes.
    stopRequested = false;
    signalMeter?.reset();
    signalMeter = null;
    set({ recorderState: 'processing', recorderError: null, meter: idleMeterSnapshot() });

    let { activeSessionId } = get();
    if (!activeSessionId) {
      // newSession is intentionally guarded while processing, so create the
      // recording session directly within this lifecycle transaction.
      const name = defaultSessionTitle();
      try {
        const session = await getClient().createSession(name, recordingMode);
        set((s) => ({ sessions: [session, ...s.sessions], activeSessionId: session.id, languageMarks: [] }));
        const created = await getClient().getSession(session.id);
        set({
          detail: { segments: created.segments, messages: created.messages, notes: created.notes, notes_list: created.notes_list },
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
    if (!activeSessionId || stopRequested) return;
    const sessionId = activeSessionId;
    recordingSessionId = sessionId;
    nativeFailureCleanup?.();
    let transportOpened = false;
    let elapsedOffsetMs = 0;
    const writer = new NativeAudioWriter(getClient(), sessionId, (opened) => {
      if (!transportOpened) elapsedOffsetMs = opened.saved_samples * 1000 / opened.sample_rate;
      transportOpened = true;
    }, true);
    nativeWriter = writer;
    nativeFailureCleanup = getClient().onNativeFailure((failure) => {
      if (!nativeFailureCleanup || nativeWriter !== writer || failure.sessionId !== sessionId) return;
      writer.disconnect();
      set({ recorderError: 'Local audio transport failed. Capture stopped; explicit retry is required.' });
      void get().stopRecording();
    });

    persistenceQueue = new PersistenceQueue({
      store: async (chunk) => {
        const result = await writer.store(chunk);
        // A durable append invalidates existing notes immediately, even if the
        // Notes tab is hidden. Reopening reads authoritative backend revisions.
        set((state) => state.activeSessionId !== sessionId || !state.detail ? {} : {
          detail: {
            ...state.detail,
            notes: state.detail.notes ? { ...state.detail.notes, stale: true } : null,
            notes_list: state.detail.notes_list?.map((note) => ({ ...note, stale: true })),
          },
        });
        return result;
      },
      maxPending: 64, // Bounded 6.4s transport buffer absorbs brief backend stalls.
      maxAttempts: 1, // An uncertain durable ACK requires explicit clock reconciliation.
      onChange: (queueState) => set({ queue: queueState }),
      onBlocked: () => {
        set({ recorderError: 'Audio delivery is interrupted. Capture stopped; buffered audio is retained for explicit retry.' });
        void get().stopRecording();
      },
    });
    set({ queue: persistenceQueue.getState() });

    const sessionMeter = new SignalMeter();
    signalMeter = sessionMeter;
    recorder = new AudioRecorder({
      onReady: (rate) => writer.open(rate),
      onChunk: (chunk: RecordedChunk) => {
        return persistenceQueue?.enqueue({
          sequence: chunk.sequence,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          wav: chunk.wav,
        });
      },
      onLevel: (level) => set({ level }),
      onSignal: (sample) => {
        if (signalMeter !== sessionMeter || get().activeSessionId !== sessionId) return;
        const snapshot = sessionMeter.push(
          sample.rms,
          sample.peak,
          sample.sampleCount,
          sample.sampleRate,
        );
        if (snapshot) set({ meter: snapshot });
      },
      onCaptureIncomplete: () => set({ captureIncomplete: true }),
      onError: (message) => set({ recorderError: message }),
      onDisconnected: () => {
        if (!get().captureIncomplete) set({ recorderError: 'Microphone disconnected. Captured audio was flushed.' });
        void get().stopRecording();
      },
    }, { windowSeconds: 0.1 });

    try {
      const activeRecorder = recorder;
      await activeRecorder.start(get().selectedDeviceId ?? undefined);
      if (stopRequested || recorder !== activeRecorder) return;
      const intent = beginSessionStatusIntent(sessionId, 'recording');
      set({ recorderState: 'recording', recorderError: null, permissionState: 'granted' });
      const acknowledged = await acknowledgeSessionStatus(sessionId, 'recording', {}, intent);
      if (!acknowledged) {
        if (intent.generation !== sessionStatusIntentGeneration) return;
        if (activeRecorder.state !== 'idle' && activeRecorder.state !== 'stopped') {
          await activeRecorder.stop().catch(() => undefined);
          await persistenceQueue?.drain();
        }
        set({
          pendingSessionStatus: null,
          pendingSessionStatusSessionId: null,
          recorderState: 'idle',
          meter: idleMeterSnapshot(),
        });
        recorder = null;
        if (recordingSessionId === sessionId) recordingSessionId = null;
        signalMeter?.reset();
        signalMeter = null;
        return;
      }
      if (
        stopRequested
        || recorder !== activeRecorder
        || recordingSessionId !== sessionId
      ) return;
      void get().enumerateDevices();
      if (elapsedTimer) clearInterval(elapsedTimer);
      set({ elapsedMs: elapsedOffsetMs });
      elapsedTimer = setInterval(() => set({ elapsedMs: elapsedOffsetMs + (recorder?.elapsedMs() ?? 0) }), 250);
    } catch (err) {
      const activeRecorder = recorder;
      if (activeRecorder && activeRecorder.state !== 'idle' && activeRecorder.state !== 'stopped') {
        await activeRecorder.stop().catch(() => undefined);
        await persistenceQueue?.drain();
      }
      if (stopRequested || nativeWriter !== writer) return; // Stop owns finalization after cancellation.
      if (transportOpened) {
        await acknowledgeSessionStatus(sessionId, 'stopped');
      } else {
        nativeFailureCleanup?.();
        nativeFailureCleanup = null;
      }
      const message = err instanceof Error ? err.message : String(err);
      const denied = /denied|not allowed|permission/i.test(message);
      set({
        recorderError: denied
          ? 'Microphone access was denied. Grant permission in System Settings and try again.'
          : message,
        permissionState: denied ? 'denied' : get().permissionState,
        recorderState: 'idle',
        meter: idleMeterSnapshot(),
      });
      recorder = null;
      if (recordingSessionId === sessionId) recordingSessionId = null;
      signalMeter?.reset();
      signalMeter = null;
    }
  },

  pauseRecording: async () => {
    if (get().recorderState !== 'recording') return;
    const activeRecorder = recorder;
    const sessionId = recordingSessionId;
    const intent = sessionId ? beginSessionStatusIntent(sessionId, 'paused') : null;
    signalMeter?.reset();
    set({ recorderState: 'processing', level: 0, meter: idleMeterSnapshot() });
    await activeRecorder?.pause();
    if (activeRecorder?.state === 'stopped') {
      await get().stopRecording();
      return;
    }
    const saved = await persistenceQueue?.drain() ?? true;
    if (!saved) {
      await get().stopRecording();
      return;
    }
    if (stopRequested || recorder !== activeRecorder || activeRecorder?.state !== 'paused') return;
    if (sessionId && intent) {
      await acknowledgeSessionStatus(sessionId, 'paused', {}, intent);
    }
    if (!stopRequested && recorder === activeRecorder) set({ recorderState: 'paused' });
  },

  resumeRecording: async () => {
    if (get().quitRequested) return;
    if (['idle', 'stopped'].includes(get().recorderState) && get().activeSessionId) {
      await get().startRecording();
      return;
    }
    if (get().recorderState !== 'paused') return;
    const activeRecorder = recorder;
    const sessionId = recordingSessionId;
    const intent = sessionId ? beginSessionStatusIntent(sessionId, 'recording') : null;
    signalMeter?.reset();
    set({ recorderState: 'processing', meter: idleMeterSnapshot() });
    try {
      await nativeWriter?.open();
      if (stopRequested || recorder !== activeRecorder) return;
      await activeRecorder?.resume();
    } catch (error) {
      set({ recorderState: 'paused', recorderError: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (stopRequested || recorder !== activeRecorder || recordingSessionId !== sessionId) return;
    set({ recorderState: 'recording' });
    if (sessionId && intent) {
      await acknowledgeSessionStatus(
        sessionId,
        'recording',
        { clearErrorOnSuccess: true },
        intent,
      );
    }
  },

  stopRecording: async () => {
    if (!['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    const id = recordingSessionId ?? get().activeSessionId;
    const intent = id ? beginSessionStatusIntent(id, 'stopped') : null;
    stopRequested = true;
    signalMeter?.reset();
    set({ recorderState: 'processing', level: 0, meter: idleMeterSnapshot() });
    await recorder?.stop();
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    const saved = await persistenceQueue?.drain() ?? true;
    if (!saved) {
      // Physical capture is already stopped. Keep `processing` and the quit
      // guard active until explicit local-storage retry receives durable ACKs.
      return;
    }
    if (id && intent) {
      await acknowledgeSessionStatus(id, 'stopped', {
        clearErrorOnSuccess: get().pendingSessionStatus !== null,
      }, intent);
      set({ recorderState: 'stopped', level: 0, meter: idleMeterSnapshot() });
      await get().selectSession(id);
      await get().refreshSessions();
      if (sessionMode(id) === 'contextual_local') await get().refreshContextualLive(id);
    } else {
      set({ recorderState: 'stopped', level: 0, meter: idleMeterSnapshot() });
    }
    recorder = null;
    if (recordingSessionId === id) recordingSessionId = null;
    signalMeter?.reset();
    signalMeter = null;
  },

  retrySessionStatus: async () => {
    const sessionId = get().pendingSessionStatusSessionId;
    const status = get().pendingSessionStatus;
    if (!sessionId || !status) return;
    const intent = beginSessionStatusIntent(sessionId, status);
    try {
      if (nativeWriter?.sessionId === sessionId) await nativeWriter.open();
    } catch (error) {
      set({ recorderError: error instanceof Error ? error.message : String(error) });
      return;
    }
    const acknowledged = await acknowledgeSessionStatus(
      sessionId,
      status,
      { clearErrorOnSuccess: true },
      intent,
    );
    if (!acknowledged) return;
    if (status === 'stopped' && sessionMode(sessionId) === 'contextual_local') {
      await get().refreshContextualLive(sessionId);
    }
    await get().refreshSessions();
  },

  retryFailedUploads: () => {
    void (async () => {
      try {
        await nativeWriter?.open();
        persistenceQueue?.retryFailed();
        const saved = await persistenceQueue?.drain();
        if (saved && !get().captureIncomplete) set({ recorderError: null });
        if (saved && stopRequested && get().recorderState === 'processing') await get().stopRecording();
      } catch (error) {
        set({ recorderError: error instanceof Error ? error.message : String(error) });
      }
    })();
  },

  retryFailedTranscriptions: () => {
    set({ recorderError: 'Automatic archived-audio transcription is disabled. Native gap recovery is not yet available.' });
  },

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
  setAskContext: (context) => set({ askContext: context }),
  setWindowMinutes: (minutes) => set({ windowMinutes: minutes }),

  generateNotes: async (detail) => {
    const id = get().activeSessionId;
    if (!id) return null;
    set({ notesGenerating: true, notesError: null });
    try {
      const notes = await getClient().generateNotes(id, get().settings?.output_language, detail);
      if (get().activeSessionId !== id) return null;
      set((s) => ({
        detail: s.detail ? { ...s.detail, notes,
          notes_list: [notes, ...(s.detail.notes_list ?? []).filter((n) => n.id !== notes.id)],
        } : s.detail,
        notesGenerating: false,
      }));
      return notes;
    } catch (err) {
      if (get().activeSessionId !== id) return null;
      set({ notesGenerating: false, notesError: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  // An empty note is a real stored document from the moment it is created, so the
  // first thing the user types is already covered by autosave — there is no
  // in-memory-only draft that a crash could take with it.
  createEmptyNote: async () => {
    const id = get().activeSessionId;
    if (!id) return null;
    set({ notesError: null });
    try {
      const note = await getClient().createEmptyNote(id);
      if (get().activeSessionId !== id) return null;
      set((s) => ({
        detail: s.detail ? { ...s.detail, notes: note,
          notes_list: [note, ...(s.detail.notes_list ?? [])],
        } : s.detail,
      }));
      return note;
    } catch (err) {
      if (get().activeSessionId !== id) return null;
      set({ notesError: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  /**
   * Rename a note without sending its text.
   *
   * The name is its own field, so a rename issued while the editor has unsaved
   * text cannot carry a stale copy of the document back to the server.
   */
  renameNote: async (note, title) => {
    const id = get().activeSessionId;
    if (!id || !note.id) return null;
    try {
      const renamed = await getClient().renameNote(id, note, title);
      if (get().activeSessionId !== id) return null;
      set((s) => ({
        detail: s.detail ? {
          ...s.detail,
          notes: s.detail.notes?.id === renamed.id ? renamed : s.detail.notes,
          notes_list: (s.detail.notes_list ?? []).map((n) => (n.id === renamed.id ? renamed : n)),
        } : s.detail,
      }));
      return renamed;
    } catch (err) {
      if (get().activeSessionId !== id) return null;
      set({ notesError: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  /** Soft deletion: it leaves the list, the row waits for the trash. */
  deleteNote: async (noteId) => {
    const id = get().activeSessionId;
    if (!id) return false;
    try {
      await getClient().deleteNote(id, noteId);
      if (get().activeSessionId !== id) return true;
      set((s) => ({
        detail: s.detail ? {
          ...s.detail,
          notes: s.detail.notes?.id === noteId ? null : s.detail.notes,
          notes_list: (s.detail.notes_list ?? []).filter((n) => n.id !== noteId),
        } : s.detail,
      }));
      return true;
    } catch (err) {
      if (get().activeSessionId !== id) return false;
      set({ notesError: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  // A transcript read, nothing else: it never starts ASR and never touches the
  // notes it feeds. Finals that arrived after Stop become visible to the Notes
  // tab this way instead of only after the user switches sessions.
  //
  // The notes of the response are deliberately dropped. This read races every
  // local rename, edit and deletion the panel has just applied, and taking its
  // note list would roll them back to whatever the server answered first.
  refreshTranscriptSource: async () => {
    const id = get().activeSessionId;
    if (!id) return;
    try {
      const detail = await getClient().getSession(id);
      if (get().activeSessionId !== id) return;
      // A response without a segment array is not a transcript: writing it would
      // put `undefined` where the panel iterates and take the whole pane down.
      if (!Array.isArray(detail?.segments)) return;
      set((s) => ({
        detail: s.detail ? { ...s.detail, segments: detail.segments } : s.detail,
      }));
    } catch {
      // A failed read leaves the previous transcript in place: the panel keeps
      // showing what it legitimately had rather than claiming it disappeared.
    }
  },

  setTheme: (theme) => {
    localStorage.setItem('audiohelper.theme', theme);
    set({ theme });
  },
  });
});

// Push live capture state to main so a window close / quit can be guarded while
// audio is still recording, draining, or held for retry. One-way and cheap;
// `reportCaptureState` is optional so the bridge stub used in tests is a no-op.
window.audiohelper.onPrepareQuit?.(() => useStore.getState().prepareForQuit());
window.audiohelper.onQuitCancelled?.(() => useStore.getState().cancelQuit());

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
