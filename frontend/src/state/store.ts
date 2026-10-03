import { create } from 'zustand';
import { IMPORT_RECORDING_MESSAGE } from '../lib/recordingEligibility';
import { defaultSessionTitle } from '../lib/time';
import { ApiClient, ApiError } from '../api/client';
import { useNativeProcessing, hasBackgroundTranscription } from './nativeProcessing';
import { forgetTranscript } from '../components/transcript/transcriptCache';
import { captureSourcesLocked } from './captureSources';
import type { BackendStatus, BridgeApi } from '../api/bridge';
import type {
  AskResponse,
  ChatScope,
  Citation,
  LocalModelStatus,
  LocalModelProviderName,
  LiveAsrCapabilities,
  LiveAsrDraft,
  LiveAsrFragment,
  LiveAsrResumeCompatibility,
  LiveAsrSchedulerStatus,
  LiveAsrSourceIntegrity,
  ImportView,
  BulkDeleteResult,
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
import { AudioRecorder, SystemAudioUnavailable, type CaptureSources, type RecordedChunk, type RecorderState, type SystemAudioFailure } from '../audio/recorder';
import { browserDiscovery, listInputDevices } from '../audio/devices';
import { SignalMeter, idleMeterSnapshot, type MeterSnapshot } from '../audio/meter';
import { PersistenceQueue, type PersistenceQueueState } from '../audio/persistenceQueue';
import { NativeAudioWriter } from '../audio/nativeWriter';
import type { TranscriptionQueueState } from '../audio/transcriptionQueue';
import { askScope } from '../lib/askScope';
import { onTaskSettled, selectAgentNotes, useCodex } from './codex';
import {
  attachNote,
  closeTab,
  emptyTabs,
  loadSessionTabs,
  noteName,
  openTab,
  renameTab,
  saveSessionTabs,
  type SessionTabs,
  type TabsState,
} from './noteTabs';

/** A generation running, or failed, in one tab of one session. */
export interface NoteGeneration {
  tabId: string;
  status: 'running' | 'failed';
  error: string | null;
  /** Set when Codex writes the note: its task carries status, journal and resume. */
  taskId?: string;
}

const initialNoteTabs = (): SessionTabs => {
  // Tabs left in "Генерация…" by a previous run can never be bound: the request
  // that would have filled them died with the process.
  const loaded = loadSessionTabs();
  return Object.fromEntries(Object.entries(loaded).map(([sessionId, own]) => {
    const tabs = own.tabs.filter((tab) => tab.noteId !== null);
    return [sessionId, { tabs, activeTabId: tabs.some((t) => t.id === own.activeTabId) ? own.activeTabId : (tabs.at(-1)?.id ?? null) }];
  }));
};

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
  /**
   * Whether the notes generator has final speech to read. The native summary
   * omits `segments`, so their length says nothing there; absent on caches
   * built before a server read, where segments are the only evidence.
   */
  has_transcript?: boolean;
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
  /** Stop was pressed: capture has ended, the remaining audio is being saved and
   * the provider finalises the last words. True only for that stretch, so the
   * recorder can tell it apart from the short start/pause/resume transitions. */
  finishing: boolean;
  elapsedMs: number;
  meter: MeterSnapshot;
  queue: PersistenceQueueState;
  transcription: TranscriptionQueueState;
  recorderError: string | null;
  /**
   * System audio could not be used. `start`/`resume`: nothing was captured and
   * the capsule offers Open System Settings / Record mic only. `lost`: it ended
   * mid-recording and the microphone kept recording.
   */
  systemAudioIssue: { phase: 'start' | 'resume' | 'lost'; reason: SystemAudioFailure | 'ended' } | null;
  recorderErrorsBySession: Record<string, string | null>;
  nextRecordingMode: SessionMode;
  liveCapabilities: LiveAsrCapabilities | null;
  /** Imports that are not yet settled, keyed by session id. Drives the session
   * row status and the main area, so an import is visible without opening it. */
  imports: Record<string, ImportView>;
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
  asking: boolean;
  askError: string | null;

  notesError: string | null;
  /**
   * Open note tabs of every session (docs/NOTES-POLISH-SPEC.md §3).
   *
   * Held here, not in the Notes panel, because a generation must be able to bind
   * its note to the waiting tab after the user left the panel or the session.
   */
  noteTabs: SessionTabs;
  /** At most one generation per session; sessions generate independently. */
  noteGenerations: Record<string, NoteGeneration>;

  theme: ThemeMode;

  init: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  saveSettings: (update: SettingsUpdate) => Promise<void>;
  loadModels: (provider: string, task: TaskKind) => Promise<ModelInfo[]>;
  prepareLocalModel: (provider: LocalModelProviderName, model: string) => Promise<LocalModelStatus>;
  localModelStatus: (provider: LocalModelProviderName, model: string) => Promise<LocalModelStatus>;
  deleteLocalModel: (provider: LocalModelProviderName, model: string) => Promise<LocalModelStatus>;
  refreshLiveCapabilities: () => Promise<void>;
  setNextRecordingMode: (mode: SessionMode) => void;
  changeTranscriptLanguage: (language: string) => Promise<void>;
  refreshContextualLive: (sessionId: string) => Promise<void>;
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

  refreshImports: () => Promise<void>;
  trackImport: (state: ImportView) => void;
  refreshSessions: () => Promise<void>;
  newSession: (title?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** Bulk delete; the capturing session is skipped and never sent. */
  removeSessions: (ids: string[]) => Promise<BulkDeleteResult>;

  enumerateDevices: () => Promise<void>;
  /** Persists the preferred microphone; ignored while capture sources are locked. */
  selectDevice: (deviceId: string) => Promise<void>;
  /** Persists whether system audio is mixed into the next recording stretch. */
  setCaptureSystemAudio: (enabled: boolean) => Promise<void>;

  /** `micOnly` skips system audio for this start only; the setting is unchanged. */
  startRecording: (options?: { micOnly?: boolean }) => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: (options?: { micOnly?: boolean }) => Promise<void>;
  stopRecording: () => Promise<void>;
  retrySessionStatus: () => Promise<void>;
  retryFailedUploads: () => void;
  retryFailedTranscriptions: () => void;

  ask: (question: string) => Promise<void>;
  setChatScope: (scope: ChatScope) => void;
  setAskContext: (context: AskContext | null) => void;

  /**
   * Start a generation for the active session in a new tab, or retry one in
   * `tabId`. Generation always produces a new note; it never overwrites open
   * text. Resolves to the note, or null when refused or failed.
   */
  generateNotes: (detail?: NoteDetail, tabId?: string) => Promise<Note | null>;
  /** Change the open tabs of one session and persist them. */
  updateNoteTabs: (sessionId: string, change: (state: TabsState) => TabsState) => void;
  /** Close a tab; a failed generation shown in it is forgotten with it. */
  closeNoteTab: (sessionId: string, tabId: string) => void;
  createEmptyNote: () => Promise<Note | null>;
  /** Rename without touching the document; a blank name is refused by the caller. */
  renameNote: (note: Note, title: string) => Promise<Note | null>;
  /** Permanent deletion after UI confirmation. */
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

function transcriptionUnavailableMessage(detail: string | null): string {
  return detail
    ? `Transcription is unavailable: ${detail} Check Settings → Transcription and try recording again.`
    : 'Transcription is unavailable. Check Settings → Transcription and try recording again.';
}
let nativeFailureCleanup: (() => void) | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let signalMeter: SignalMeter | null = null;
let stopRequested = false;
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
  if (!client || clientBridge !== window.skaz) {
    client = new ApiClient(window.skaz);
    clientBridge = window.skaz;
  }
  return client;
};

export const SYSTEM_AUDIO_LOST_MESSAGE = 'System audio stopped — recording microphone only.';

export function systemAudioMessage(reason: SystemAudioFailure): string {
  return reason === 'denied'
    ? 'System audio is not allowed. Grant SKAZ “System Audio Recording” in System Settings, or record the microphone only.'
    : reason === 'unsupported'
      ? 'System audio needs macOS 14.2 or later. Record the microphone only.'
      : 'System audio could not start. Try again, or record the microphone only.';
}

const messageId = (): string => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const reconcileImmutableFinals = (existing: Segment[], incoming: Segment[]): Segment[] => {
  const byId = new Map(existing.map((segment) => [segment.id, segment]));
  for (const segment of incoming) {
    if (!byId.has(segment.id)) byId.set(segment.id, segment);
  }
  return [...byId.values()].sort((a, b) => a.start_ms - b.start_ms);
};

export const useStore = create<AppState>((set, get) => {
  /** Sources for the next recording stretch, from the persisted preferences. */
  const captureSources = (micOnly = false): CaptureSources => ({
    deviceId: get().selectedDeviceId ?? undefined,
    systemAudio: !micOnly && get().settings?.capture_system_audio === true,
  });

  const sessionMode = (sessionId: string): SessionMode => (
    get().sessions.find((item) => item.id === sessionId)?.mode ?? 'legacy'
  );

  /** Drops deleted sessions from the list and, if the open one went, its view state. */
  const forgetSessions = (ids: string[]): void => {
    if (!ids.length) return;
    const gone = new Set(ids);
    for (const id of ids) forgetTranscript(id);
    const activeGone = get().activeSessionId !== null && gone.has(get().activeSessionId!);
    if (activeGone) liveSelectionGeneration += 1;
    set((s) => {
      const statusGone = s.pendingSessionStatusSessionId !== null && gone.has(s.pendingSessionStatusSessionId);
      return {
        sessions: s.sessions.filter((x) => !gone.has(x.id)),
        activeSessionId: activeGone ? null : s.activeSessionId,
        detail: activeGone ? null : s.detail,
        liveDraft: activeGone ? null : s.liveDraft,
        liveFragments: activeGone ? [] : s.liveFragments,
        liveSourceIntegrity: activeGone ? null : s.liveSourceIntegrity,
        liveResumeCompatibility: activeGone ? null : s.liveResumeCompatibility,
        liveScheduler: activeGone ? null : s.liveScheduler,
        pendingSessionStatus: statusGone ? null : s.pendingSessionStatus,
        pendingSessionStatusSessionId: statusGone ? null : s.pendingSessionStatusSessionId,
      };
    });
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
        if (writer?.transcriptionPending) useNativeProcessing.getState().pending(sessionId);
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
          recorderError: writer?.transcriptionIncomplete
            ? state.recorderError ?? `Some audio could not be transcribed${writer.incompleteDetail ? ` (${writer.incompleteDetail.replace(/\.$/, '')})` : ''}. The unconfirmed audio was cleared from memory; confirmed text was preserved.`
            : options.clearErrorOnSuccess ? null : state.recorderError,
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
      if (state.activeSessionId && (state.settings?.transcription_provider === 'local-whisper' || hasBackgroundTranscription())) {
        await useNativeProcessing.getState().refresh(state.activeSessionId);
      }
      for (const id of Object.keys(useNativeProcessing.getState().sessions)) {
        if (useNativeProcessing.getState().sessions[id]?.processing) await useNativeProcessing.getState().refresh(id);
      }
      if (hasBackgroundTranscription()) return false;
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
  finishing: false,
  elapsedMs: 0,
  meter: idleMeterSnapshot(),
  queue: emptyQueueState,
  transcription: emptyTranscriptionState,
  recorderError: null,
  recorderErrorsBySession: {},
  nextRecordingMode: 'legacy',
  liveCapabilities: null,
  imports: {},
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
  systemAudioIssue: null,
  permissionState: 'unknown',
  chatScope: 'session',
  askContext: null,
  asking: false,
  askError: null,
  notesError: null,
  noteTabs: initialNoteTabs(),
  noteGenerations: {},
  theme: (localStorage.getItem('skaz.theme') as ThemeMode | null) ?? 'system',

  init: async () => {
    const bridge = window.skaz;
    set({ backend: await bridge.getBackendStatus() });
    bridge.onBackendStatus((status) => {
      set({ backend: status, ready: status.phase === 'ready' });
      if (status.phase === 'ready') {
        void get().refreshSettings();
        void get().refreshSessions();
        void get().refreshLiveCapabilities();
        void get().refreshImports();
      }
    });
    if (get().backend.phase === 'ready') {
      set({ ready: true });
      await Promise.all([
        get().refreshSettings(), get().refreshSessions(), get().refreshLiveCapabilities(),
        get().refreshImports(),
      ]);
    }
  },

  refreshSettings: async () => {
    try {
      const settings = await getClient().getSettings();
      set((s) => ({ settings, settingsError: null, selectedDeviceId: settings.input_device_id ?? s.selectedDeviceId }));
    } catch (err) {
      set({ settingsError: err instanceof Error ? err.message : String(err) });
    }
  },

  saveSettings: async (update) => {
    try {
      const settings = await getClient().updateSettings(update);
      set((s) => ({ settings, settingsError: null, selectedDeviceId: settings.input_device_id ?? s.selectedDeviceId }));
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

  refreshImports: async () => {
    try {
      const active = await getClient().getActiveImports();
      set({ imports: Object.fromEntries(active.map((item) => [item.session_id, item])) });
    } catch {
      // A failed listing must not erase what we already know about in-flight
      // imports; the per-session poller keeps each one honest on its own.
    }
  },

  trackImport: (state) => {
    set((s) => {
      const next = { ...s.imports };
      // Settled imports leave the map: the session then behaves like any other.
      if (state.status === 'completed' || state.status === 'cancelled') delete next[state.session_id];
      else next[state.session_id] = state;
      return { imports: next };
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
      recorderErrorsBySession: s.activeSessionId
        ? { ...s.recorderErrorsBySession, [s.activeSessionId]: s.recorderError }
        : s.recorderErrorsBySession,
      recorderError: s.activeSessionId === id ? s.recorderError : s.recorderErrorsBySession[id] ?? null,
      detailLoading: true,
      detailError: null,
      asking: false,
      askError: null,
      // Scope is sticky within a session but must not leak into the next one:
      // another session must never inherit Group / All access.
      chatScope: s.activeSessionId === id ? s.chatScope : 'session',
      // A quoted notes fragment belongs to the session it came from.
      askContext: s.activeSessionId === id ? s.askContext : null,
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
      const detail: SessionDetail = await getClient().getSession(id, true);
      if (get().activeSessionId !== id || generation !== liveSelectionGeneration) return;
      set({
        detail: { segments: detail.segments, messages: detail.messages, notes: detail.notes, notes_list: detail.notes_list, has_transcript: detail.has_transcript },
        detailLoading: false,
      });
      if (detail.session.origin === 'import') {
        const imported = await getClient().getImport(id);
        get().trackImport(imported);
      }
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
    forgetSessions([id]);
    const next = get().sessions[0];
    if (next) await get().selectSession(next.id);
  },

  removeSessions: async (ids) => {
    // The capturing session is never sent: its audio pipeline still owns it.
    const capturing = ['recording', 'paused', 'processing'].includes(get().recorderState) ? get().activeSessionId : null;
    const sendable = [...new Set(ids)].filter((id) => id !== capturing);
    if (!sendable.length) return { deleted: [], failed: [] };
    const wasActive = get().activeSessionId;
    const result = await getClient().deleteSessions(sendable);
    forgetSessions(result.deleted);
    if (wasActive && result.deleted.includes(wasActive)) {
      const next = get().sessions[0];
      if (next) await get().selectSession(next.id);
    }
    return result;
  },

  enumerateDevices: async () => {
    try {
      // Labels stay hidden until the microphone grant exists, so this may
      // prompt once on macOS; without it the picker shows "Microphone 1".
      const devices = await listInputDevices(browserDiscovery);
      set((s) => ({
        devices,
        selectedDeviceId: s.selectedDeviceId ?? devices[0]?.deviceId ?? null,
      }));
    } catch (err) {
      set({ recorderError: err instanceof Error ? err.message : String(err) });
    }
  },

  selectDevice: async (deviceId) => {
    if (captureSourcesLocked(get().recorderState)) return;
    const previous = get().selectedDeviceId;
    set({ selectedDeviceId: deviceId });
    try {
      await get().saveSettings({ input_device_id: deviceId });
    } catch (error) {
      set({ selectedDeviceId: previous });
      throw error;
    }
  },

  setCaptureSystemAudio: async (enabled) => {
    if (captureSourcesLocked(get().recorderState)) return;
    await get().saveSettings({ capture_system_audio: enabled });
  },

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
                ...(typeof detail.has_transcript === 'boolean' ? { has_transcript: detail.has_transcript } : {}),
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

  startRecording: async (options = {}) => {
    if (get().quitRequested) return;
    if (Object.values(get().imports).some((s) => ['queued', 'downloading', 'preparing', 'uploading', 'processing'].includes(s.status))) {
      set({ recorderError: 'Finish or cancel the media import before recording.' });
      return;
    }
    if (get().sessions.find((session) => session.id === get().activeSessionId)?.origin === 'import') {
      set({ recorderError: IMPORT_RECORDING_MESSAGE });
      return;
    }
    if (['recording', 'paused', 'processing'].includes(get().recorderState)) return;
    if (get().pendingSessionStatus) {
      const previous = get().pendingSessionStatus === 'stopped' ? 'Stop'
        : get().pendingSessionStatus === 'paused' ? 'Pause' : 'Record';
      set({ recorderError: `The previous ${previous} was not confirmed by the backend yet. Use its Retry confirmation button, then record again.` });
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
      set({ recorderError: 'Before the first recording, choose the languages in use in Settings → System.' });
      return;
    }
    const recordingMode: SessionMode = 'legacy';
    // Local persistence is allowed without cloud consent. The independent ASR
    // scheduler enforces consent before it fetches or submits persisted bytes.
    stopRequested = false;
    signalMeter?.reset();
    signalMeter = null;
    set({ recorderState: 'processing', finishing: false, recorderError: null, systemAudioIssue: null, meter: idleMeterSnapshot() });

    let { activeSessionId } = get();
    if (!activeSessionId) {
      // newSession is intentionally guarded while processing, so create the
      // recording session directly within this lifecycle transaction.
      const name = defaultSessionTitle();
      try {
        const session = await getClient().createSession(name, recordingMode);
        set((s) => ({ sessions: [session, ...s.sessions], activeSessionId: session.id, languageMarks: [] }));
        const created = await getClient().getSession(session.id, true);
        set({
          detail: { segments: created.segments, messages: created.messages, notes: created.notes, notes_list: created.notes_list, has_transcript: created.has_transcript },
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
    let captureRate: number | undefined;
    try {
      const snapshot = await getClient().getNativeSnapshot(sessionId);
      if (snapshot.processing) {
        useNativeProcessing.getState().pending(sessionId);
        set({ recorderState: 'stopped' });
        return;
      }
      captureRate = snapshot.sample_rate;
    } catch (error) {
      // A new session has no native clock yet; every other read failure is real.
      if (!(error instanceof ApiError && error.status === 404)) {
        set({ recorderState: 'stopped', recorderError: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    if (stopRequested) return;
    recordingSessionId = sessionId;
    nativeFailureCleanup?.();
    let transportOpened = false;
    let elapsedOffsetMs = 0;
    const writer = new NativeAudioWriter(getClient(), sessionId, (opened) => {
      if (!transportOpened) elapsedOffsetMs = opened.saved_samples * 1000 / opened.sample_rate;
      transportOpened = true;
      useNativeProcessing.getState().started(sessionId);
    }, true);
    nativeWriter = writer;
    nativeFailureCleanup = getClient().onNativeFailure((failure) => {
      if (!nativeFailureCleanup || nativeWriter !== writer || failure.sessionId !== sessionId) return;
      if (failure.code === 'transcription_failed') {
        const reason = failure.reason ? ` ${failure.reason.replace(/\.?$/, '.')}` : '';
        set({ recorderError: `Transcription failed.${reason} Recording stopped. The unconfirmed audio could not be transcribed and was cleared from memory. Try recording again.` });
        if (!stopRequested) void get().stopRecording();
        return;
      }
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
      onReady: async (rate) => {
        await writer.open(rate);
        if (!writer.transcriptionAvailable) {
          throw new Error(transcriptionUnavailableMessage(writer.transcriptionDetail));
        }
      },
      onChunk: (chunk: RecordedChunk) => {
        return persistenceQueue?.enqueue({
          sequence: chunk.sequence,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          wav: chunk.wav,
        });
      },
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
      onSystemAudioLost: () => set({
        systemAudioIssue: { phase: 'lost', reason: 'ended' },
        recorderError: SYSTEM_AUDIO_LOST_MESSAGE,
      }),
      onError: (message) => set({ recorderError: message }),
      onDisconnected: () => {
        if (!get().captureIncomplete) set({ recorderError: 'Microphone disconnected. Captured audio was flushed.' });
        void get().stopRecording();
      },
    }, { windowSeconds: 0.1, sampleRate: captureRate });

    try {
      const activeRecorder = recorder;
      await activeRecorder.start(captureSources(options.micOnly));
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
      if (err instanceof SystemAudioUnavailable) {
        set({
          recorderError: systemAudioMessage(err.reason),
          systemAudioIssue: { phase: 'start', reason: err.reason },
          recorderState: 'idle',
          meter: idleMeterSnapshot(),
        });
        recorder = null;
        if (recordingSessionId === sessionId) recordingSessionId = null;
        signalMeter?.reset();
        signalMeter = null;
        return;
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
    set({ recorderState: 'processing', meter: idleMeterSnapshot() });
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

  resumeRecording: async (options = {}) => {
    if (get().quitRequested) return;
    if (Object.values(get().imports).some((s) => ['queued', 'downloading', 'preparing', 'uploading', 'processing'].includes(s.status))) {
      set({ recorderError: 'Finish or cancel the media import before recording.' });
      return;
    }
    if (get().sessions.find((session) => session.id === get().activeSessionId)?.origin === 'import') {
      set({ recorderError: IMPORT_RECORDING_MESSAGE });
      return;
    }
    if (['idle', 'stopped'].includes(get().recorderState) && get().activeSessionId) {
      await get().startRecording(options);
      return;
    }
    if (get().recorderState !== 'paused') return;
    const pausedSessionId = recordingSessionId;
    if (pausedSessionId) {
      try { await useNativeProcessing.getState().refresh(pausedSessionId); }
      catch { set({ recorderError: 'Could not verify background transcription status.' }); return; }
      if (useNativeProcessing.getState().sessions[pausedSessionId]?.processing) return;
    }
    const activeRecorder = recorder;
    const sessionId = recordingSessionId;
    const intent = sessionId ? beginSessionStatusIntent(sessionId, 'recording') : null;
    signalMeter?.reset();
    set({ recorderState: 'processing', recorderError: null, systemAudioIssue: null, meter: idleMeterSnapshot() });
    // Sources may have changed while paused. Swap them before the transport
    // reopens, so a refused system-audio grant leaves nothing half-started.
    try {
      await activeRecorder?.changeSources(captureSources(options.micOnly));
    } catch (error) {
      if (error instanceof SystemAudioUnavailable) {
        set({
          recorderState: 'paused',
          recorderError: systemAudioMessage(error.reason),
          systemAudioIssue: { phase: 'resume', reason: error.reason },
        });
      } else {
        set({ recorderState: 'paused', recorderError: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    try {
      await nativeWriter?.open();
      if (nativeWriter && !nativeWriter.transcriptionAvailable) {
        set({ recorderError: transcriptionUnavailableMessage(nativeWriter.transcriptionDetail) });
        await get().stopRecording();
        return;
      }
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
    const activeRecorder = recorder;
    const id = recordingSessionId ?? get().activeSessionId;
    const intent = id ? beginSessionStatusIntent(id, 'stopped') : null;
    stopRequested = true;
    signalMeter?.reset();
    set({ recorderState: 'processing', finishing: true, meter: idleMeterSnapshot() });
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
      set({ recorderState: 'stopped', finishing: false, meter: idleMeterSnapshot() });
      await get().selectSession(id);
      await get().refreshSessions();
      if (sessionMode(id) === 'contextual_local') await get().refreshContextualLive(id);
    } else {
      set({ recorderState: 'stopped', finishing: false, meter: idleMeterSnapshot() });
    }
    // Record is already available while the read-model refresh is in flight.
    // A completed old Stop must never detach the user's new capture.
    if (recorder === activeRecorder) {
      recorder = null;
      if (recordingSessionId === id) recordingSessionId = null;
      signalMeter?.reset();
      signalMeter = null;
    }
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
    if (!id || !question.trim() || get().asking) return;
    const selectedScope = get().chatScope;
    const selectedSessions = get().sessions;
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
      const filter = selectedScope === 'group'
        ? await askScope(getClient(), selectedScope, id, selectedSessions)
        : { search_scope: selectedScope };
      if (get().activeSessionId !== id) return;
      const res: AskResponse = await getClient().ask(id, {
        question: question.trim(),
        ...filter,
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
      set((s) => ({
        asking: false, askError: err instanceof Error ? err.message : String(err),
        detail: s.detail ? { ...s.detail, messages: s.detail.messages.filter((m) => m.id !== userMsg.id) } : s.detail,
      }));
    }
  },

  setChatScope: (scope) => set({ chatScope: scope }),
  setAskContext: (context) => set({ askContext: context }),

  updateNoteTabs: (sessionId, change) => {
    set((s) => {
      const next = change(s.noteTabs[sessionId] ?? emptyTabs);
      if (next === s.noteTabs[sessionId]) return {};
      const noteTabs = { ...s.noteTabs, [sessionId]: next };
      saveSessionTabs(noteTabs);
      return { noteTabs };
    });
  },

  closeNoteTab: (sessionId, tabId) => {
    get().updateNoteTabs(sessionId, (state) => closeTab(state, tabId));
    // A running generation keeps going (spec §5): its note lands in the list.
    // A failure has nothing left to show once its tab is gone.
    set((s) => {
      const running = s.noteGenerations[sessionId];
      if (!running || running.tabId !== tabId || running.status !== 'failed') return {};
      const { [sessionId]: _dropped, ...rest } = s.noteGenerations;
      return { noteGenerations: rest };
    });
  },

  /**
   * Generate a note into a tab, surviving the panel and the selected session.
   *
   * The tab is opened before the request so the user sees that something
   * started; the note is bound to it only when it arrives. Both the tab and the
   * running state are keyed by the session the request was made for, so leaving
   * the Notes pane or selecting another session no longer strands the result.
   */
  generateNotes: async (detail, retryTabId) => {
    const id = get().activeSessionId;
    if (!id || get().noteGenerations[id]?.status === 'running') return null;
    let tabId = retryTabId ?? '';
    get().updateNoteTabs(id, (state) => {
      if (retryTabId) return renameTab(state, retryTabId, 'Generating…');
      const opened = openTab(state, { sessionId: id, noteId: null, title: 'Generating…' });
      tabId = opened.activeTabId ?? '';
      return opened;
    });
    set((s) => ({
      notesError: null,
      noteGenerations: { ...s.noteGenerations, [id]: { tabId, status: 'running', error: null } },
    }));
    const forget = (s: AppState) => {
      const { [id]: _done, ...rest } = s.noteGenerations;
      return rest;
    };
    if (selectAgentNotes(useCodex.getState())) {
      // Codex or API agent mode: always this session's confirmed snapshot, whatever the chat scope.
      // The note arrives when the task completes (see onTaskSettled below).
      try {
        const task = await useCodex.getState().generateNotes(id, get().settings?.output_language ?? 'auto', detail ?? 'normal');
        set((s) => ({ noteGenerations: { ...s.noteGenerations, [id]: { tabId, status: 'running', error: null, taskId: task.id } } }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((s) => ({ noteGenerations: { ...s.noteGenerations, [id]: { tabId, status: 'failed', error: message || 'Could not start the notes' } } }));
      }
      return null;
    }
    try {
      const notes = await getClient().generateNotes(id, get().settings?.output_language, detail);
      set((s) => ({
        noteGenerations: forget(s),
        // Another session on screen reads this note from the server when it is
        // selected again; only the session actually shown takes it in place.
        detail: s.activeSessionId === id && s.detail ? { ...s.detail, notes,
          notes_list: [notes, ...(s.detail.notes_list ?? []).filter((n) => n.id !== notes.id)],
        } : s.detail,
      }));
      if (notes.id) {
        get().updateNoteTabs(id, (state) => (state.tabs.some((tab) => tab.id === tabId)
          ? renameTab(attachNote(state, tabId, notes.id!), tabId, noteName(notes))
          : state));
      }
      return notes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const tabOpen = (get().noteTabs[id]?.tabs ?? []).some((tab) => tab.id === tabId);
      set((s) => ({
        noteGenerations: tabOpen
          ? { ...s.noteGenerations, [id]: { tabId, status: 'failed', error: message || 'Could not create the notes' } }
          : forget(s),
      }));
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

  /** Permanent deletion; update the list only after success. */
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
      const detail = await getClient().getSession(id, true);
      if (get().activeSessionId !== id) return;
      // A response without a segment array is not a transcript: writing it would
      // put `undefined` where the panel iterates and take the whole pane down.
      if (!Array.isArray(detail?.segments)) return;
      set((s) => ({
        detail: s.detail ? {
          ...s.detail,
          segments: detail.segments,
          ...(typeof detail.has_transcript === 'boolean' ? { has_transcript: detail.has_transcript } : {}),
        } : s.detail,
      }));
    } catch {
      // A failed read leaves the previous transcript in place: the panel keeps
      // showing what it legitimately had rather than claiming it disappeared.
    }
  },

  setTheme: (theme) => {
    localStorage.setItem('skaz.theme', theme);
    set({ theme });
  },
  });
});

// Push live capture state to main so a window close / quit can be guarded while
// audio is still recording, draining, or held for retry. One-way and cheap;
// `reportCaptureState` is optional so the bridge stub used in tests is a no-op.
window.skaz.onPrepareQuit?.(() => useStore.getState().prepareForQuit());
window.skaz.onQuitCancelled?.(() => useStore.getState().cancelQuit());

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
  window.skaz.reportCaptureState?.(snapshot);
});

// A Codex notes task that ended: a completed one binds its note to the tab that
// was waiting for it (and refreshes the list if that session is on screen); an
// unfinished one leaves the tab showing why, with its task still reachable for a
// manual resume. Tasks restored after a restart have no tab and only refresh.
onTaskSettled((task) => {
  if (task.kind !== 'notes') return;
  const state = useStore.getState();
  const entry = Object.entries(state.noteGenerations).find(([, g]) => g.taskId === task.id);
  const sessionId = entry?.[0] ?? task.session_ids[0];
  if (!sessionId) return;
  const generation = entry?.[1];
  if (task.status !== 'completed' || !task.note_id) {
    if (!generation) return;
    // An API provider's classified error says what went wrong; Codex pauses without one.
    const reason = task.status === 'paused' && task.engine === 'api' && task.error ? task.error
      : task.status === 'paused' ? 'Generation was interrupted and waits to be resumed manually.'
      : task.status === 'cancelled' ? 'Generation stopped.'
      : task.error || 'Could not create the notes';
    useStore.setState((s) => ({ noteGenerations: { ...s.noteGenerations, [sessionId]: { ...generation, status: 'failed', error: reason } } }));
    return;
  }
  const noteId = task.note_id;
  void getClient().listNotes(sessionId).then(({ notes }) => {
    const note = notes.find((n) => n.id === noteId);
    useStore.setState((s) => {
      const { [sessionId]: _done, ...rest } = s.noteGenerations;
      return {
        noteGenerations: generation ? rest : s.noteGenerations,
        detail: s.activeSessionId === sessionId && s.detail
          ? { ...s.detail, notes: note ?? s.detail.notes, notes_list: notes } : s.detail,
      };
    });
    if (generation) {
      useStore.getState().updateNoteTabs(sessionId, (tabs) => (tabs.tabs.some((tab) => tab.id === generation.tabId)
        ? renameTab(attachNote(tabs, generation.tabId, noteId), generation.tabId, note ? noteName(note) : 'Notes')
        : tabs));
    }
  }).catch((err: unknown) => {
    if (!generation) return;
    useStore.setState((s) => ({ noteGenerations: { ...s.noteGenerations, [sessionId]: { ...generation, status: 'failed',
      error: `Notes created, but the notes list could not be read: ${err instanceof Error ? err.message : String(err)}` } } }));
  });
});
