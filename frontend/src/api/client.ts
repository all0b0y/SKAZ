import type {
  AudioUploadMeta,
  BridgeApi,
  JsonResponse,
} from './bridge';
import type { NativeAudioMeta, NativeOpened, NativeSaved, NativeStopped, NativeFailure, NativeSnapshot } from './nativeLive';
import type {
  AskRequest,
  AskResponse,
  AudioIngestResponse,
  AudioManifestPage,
  StoredAudioResponse,
  LocalModelStatus,
  LocalProviderName,
  LiveAsrAdvanceResponse,
  AcceptLiveAsrFragmentRequest,
  EditLiveAsrFragmentRequest,
  LiveAsrCapabilities,
  LiveAsrFragment,
  LiveAsrResponse,
  LiveAsrSchedulerStatus,
  ModelsResponse,
  Note,
  NoteDetail,
  RewritePreview,
  Session,
  SessionDetail,
  SessionFilesStatus,
  SessionStatus,
  SessionMode,
  SessionStatusOptions,
  Settings,
  SettingsUpdate,
  StorageRootView,
  TaskKind,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface StorageLayout {
  enabled: boolean;
  revision: number;
  data: import('../lib/sessionGroups').SessionGroups;
  pending: { kind: string; phase: string } | null;
}

function unwrap<T>(res: JsonResponse<T>): T {
  if (!res.ok) throw new ApiError(res.status, res.detail);
  return res.data;
}

// Typed wrapper over the preload bridge. All methods speak the docs/API.md
// contract (snake_case wire shapes) and throw ApiError on any non-2xx.
export class ApiClient {
  constructor(private readonly bridge: BridgeApi) {}

  getStorageLayout(): Promise<StorageLayout> {
    return this.bridge.request<StorageLayout>({ method: 'GET', path: '/storage/layout' }).then(unwrap);
  }

  enableStorageLayout(): Promise<StorageLayout> {
    return this.bridge.request<StorageLayout>({ method: 'POST', path: '/storage/layout' }).then(unwrap);
  }

  recoverStorage(): Promise<StorageLayout> {
    return this.bridge.request<StorageLayout>({ method: 'POST', path: '/storage/recover' }).then(unwrap);
  }

  moveStorageRoot(root: string, expectedRoot: string): Promise<StorageLayout> {
    return this.bridge.request<StorageLayout>({ method: 'POST', path: '/storage/move-root',
      body: { root, expected_root: expectedRoot } }).then(unwrap);
  }

  updateStorageGroups(data: import('../lib/sessionGroups').SessionGroups, revision: number): Promise<StorageLayout> {
    return this.bridge.request<StorageLayout>({ method: 'PUT', path: '/storage/groups',
      body: { data, expected_revision: revision } }).then(unwrap);
  }

  openNative(sessionId: string, sampleRate: number): Promise<NativeOpened> {
    return this.bridge.openNative(sessionId, sampleRate).then(unwrap);
  }

  sendNativeAudio(sessionId: string, meta: NativeAudioMeta, pcm: ArrayBuffer): Promise<NativeSaved> {
    return this.bridge.sendNativeAudio(sessionId, meta, pcm).then(unwrap);
  }

  endNative(sessionId: string, action: 'pause' | 'stop'): Promise<NativeStopped> {
    return this.bridge.endNative(sessionId, action).then(unwrap);
  }

  onNativeFailure(callback: (failure: NativeFailure) => void): () => void {
    return this.bridge.onNativeFailure(callback);
  }

  getNativeSnapshot(sessionId: string): Promise<NativeSnapshot> {
    return this.bridge.request<NativeSnapshot>({
      method: 'GET', path: `/sessions/${encodeURIComponent(sessionId)}/live`,
    }).then(unwrap);
  }

  getStorageRoot(): Promise<StorageRootView> {
    return this.bridge.request<StorageRootView>({ method: 'GET', path: '/storage/root' }).then(unwrap);
  }

  updateStorageRoot(root: string | null, expectedRoot: string | null): Promise<StorageRootView> {
    return this.bridge.request<StorageRootView>({
      method: 'PUT', path: '/storage/root', body: { root, expected_root: expectedRoot },
    }).then(unwrap);
  }

  getSettings(): Promise<Settings> {
    return this.bridge.request<Settings>({ method: 'GET', path: '/settings' }).then(unwrap);
  }

  updateSettings(update: SettingsUpdate): Promise<Settings> {
    return this.bridge
      .request<Settings>({ method: 'PUT', path: '/settings', body: update })
      .then(unwrap);
  }

  getModels(provider: string, task: TaskKind): Promise<ModelsResponse> {
    return this.bridge
      .request<ModelsResponse>({ method: 'GET', path: '/models', query: { provider, task } })
      .then(unwrap);
  }

  // This UI-facing preparation route may download weights and must be called only
  // on an explicit user action, never on mount or as a side effect of saving
  // settings. The backend's separate environment opt-in is unchanged.
  prepareLocalModel(provider: LocalProviderName, model: string): Promise<LocalModelStatus> {
    return this.bridge
      .request<LocalModelStatus>({
        method: 'POST',
        path: '/models/local/prepare',
        body: { provider, model },
      })
      .then(unwrap);
  }

  getLocalModelStatus(provider: LocalProviderName, model: string): Promise<LocalModelStatus> {
    return this.bridge
      .request<LocalModelStatus>({
        method: 'GET',
        path: '/models/local/status',
        query: { provider, model },
      })
      .then(unwrap);
  }

  deleteLocalModel(provider: LocalProviderName, model: string): Promise<LocalModelStatus> {
    return this.bridge
      .request<LocalModelStatus>({
        method: 'DELETE',
        path: '/models/local',
        body: { provider, model, confirmation_model: model },
      })
      .then(unwrap);
  }

  listSessions(): Promise<Session[]> {
    return this.bridge
      .request<{ sessions: Session[] }>({ method: 'GET', path: '/sessions' })
      .then(unwrap)
      .then((r) => r.sessions);
  }

  createSession(title: string, mode: SessionMode = 'legacy'): Promise<Session> {
    return this.bridge
      .request<Session>({ method: 'POST', path: '/sessions', body: { title, mode } })
      .then(unwrap);
  }

  getLiveAsrCapabilities(): Promise<LiveAsrCapabilities> {
    return this.bridge.request<LiveAsrCapabilities>({ method: 'GET', path: '/asr/live/capabilities' }).then(unwrap);
  }

  getLiveAsr(id: string): Promise<LiveAsrResponse> {
    return this.bridge.request<LiveAsrResponse>({ method: 'GET', path: `/sessions/${encodeURIComponent(id)}/asr/live` }).then(unwrap);
  }

  getLiveAsrScheduler(id: string): Promise<LiveAsrSchedulerStatus> {
    return this.bridge.request<LiveAsrSchedulerStatus>({ method: 'GET', path: `/sessions/${encodeURIComponent(id)}/asr/live/scheduler` }).then(unwrap);
  }

  advanceLiveAsr(id: string, throughSequence: number): Promise<LiveAsrAdvanceResponse> {
    return this.bridge.request<LiveAsrAdvanceResponse>({
      method: 'POST', path: `/sessions/${encodeURIComponent(id)}/asr/live/advance`,
      body: { through_sequence: throughSequence },
    }).then(unwrap);
  }

  getLiveAsrFragments(id: string): Promise<LiveAsrFragment[]> {
    return this.bridge.request<{ fragments: LiveAsrFragment[] }>({
      method: 'GET', path: `/sessions/${encodeURIComponent(id)}/asr/fragments`,
    }).then(unwrap).then((response) => response.fragments);
  }

  editLiveAsrFragment(
    sessionId: string,
    fragmentId: string,
    request: EditLiveAsrFragmentRequest,
  ): Promise<LiveAsrFragment> {
    return this.bridge.request<LiveAsrFragment>({
      method: 'PUT',
      path: `/sessions/${encodeURIComponent(sessionId)}/asr/fragments/${encodeURIComponent(fragmentId)}/text`,
      body: request,
    }).then(unwrap);
  }

  acceptLiveAsrFragment(
    sessionId: string,
    fragmentId: string,
    request: AcceptLiveAsrFragmentRequest,
  ): Promise<LiveAsrFragment> {
    return this.bridge.request<LiveAsrFragment>({
      method: 'POST',
      path: `/sessions/${encodeURIComponent(sessionId)}/asr/fragments/${encodeURIComponent(fragmentId)}/accept`,
      body: request,
    }).then(unwrap);
  }

  getSession(id: string): Promise<SessionDetail> {
    return this.bridge
      .request<SessionDetail>({ method: 'GET', path: `/sessions/${encodeURIComponent(id)}` })
      .then(unwrap);
  }

  getSessionFiles(id: string): Promise<SessionFilesStatus> {
    return this.bridge.request<SessionFilesStatus>({
      method: 'GET', path: `/sessions/${encodeURIComponent(id)}/files`,
    }).then(unwrap);
  }

  projectSessionFiles(id: string): Promise<SessionFilesStatus> {
    return this.bridge.request<SessionFilesStatus>({
      method: 'POST', path: `/sessions/${encodeURIComponent(id)}/files`,
    }).then(unwrap);
  }

  preserveSessionFiles(id: string): Promise<SessionFilesStatus> {
    return this.bridge.request<SessionFilesStatus>({
      method: 'POST', path: `/sessions/${encodeURIComponent(id)}/files/preserve`,
    }).then(unwrap);
  }

  setSessionStatus(id: string, status: SessionStatus, options: SessionStatusOptions = {}): Promise<Session> {
    const body: { status: SessionStatus } & SessionStatusOptions = { status, ...options };
    return this.bridge
      .request<Session>({ method: 'PATCH', path: `/sessions/${encodeURIComponent(id)}`, body })
      .then(unwrap);
  }

  renameSession(id: string, title: string, status: SessionStatus): Promise<Session> {
    return this.setSessionStatus(id, status, { title });
  }

  deleteSession(id: string): Promise<void> {
    return this.bridge
      .request<{ deleted: boolean }>({
        method: 'DELETE',
        path: `/sessions/${encodeURIComponent(id)}`,
      })
      .then(unwrap)
      .then(() => undefined);
  }

  uploadAudio(sessionId: string, meta: AudioUploadMeta, wav: ArrayBuffer): Promise<AudioIngestResponse> {
    return this.bridge.uploadAudio<AudioIngestResponse>(sessionId, meta, wav).then(unwrap);
  }

  storeAudio(sessionId: string, meta: AudioUploadMeta, wav: ArrayBuffer): Promise<StoredAudioResponse> {
    return this.bridge.storeAudio<StoredAudioResponse>(sessionId, meta, wav).then(unwrap);
  }

  getAudioManifestPage(
    sessionId: string,
    afterSequence?: number,
    limit = 100,
  ): Promise<AudioManifestPage> {
    const query: { after_sequence?: number; limit: number } = { limit };
    if (afterSequence !== undefined) query.after_sequence = afterSequence;
    return this.bridge
      .request<AudioManifestPage>({
        method: 'GET',
        path: `/sessions/${encodeURIComponent(sessionId)}/audio`,
        query,
      })
      .then(unwrap);
  }

  ask(sessionId: string, req: AskRequest): Promise<AskResponse> {
    return this.bridge
      .request<AskResponse>({
        method: 'POST',
        path: `/sessions/${encodeURIComponent(sessionId)}/ask`,
        body: req,
      })
      .then(unwrap);
  }

  editNote(sessionId: string, note: Note, content: string): Promise<Note> {
    return this.bridge.request<Note>({ method: 'PATCH',
      path: `/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(note.id!)}`,
      body: { content, expected_revision: note.revision },
    }).then(unwrap);
  }

  /**
   * Rename without touching the document — the Obsidian model.
   *
   * The body carries no `content`, so a rename can never race an in-flight edit
   * into overwriting the text with a stale copy held by the tab strip.
   */
  renameNote(sessionId: string, note: Note, title: string): Promise<Note> {
    return this.bridge.request<Note>({ method: 'PATCH',
      path: `/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(note.id!)}`,
      body: { title, expected_revision: note.revision },
    }).then(unwrap);
  }

  /** Soft deletion: the row waits for the trash, so a mistaken click is recoverable. */
  deleteNote(sessionId: string, noteId: string): Promise<{ deleted: boolean }> {
    return this.bridge.request<{ deleted: boolean }>({ method: 'DELETE',
      path: `/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(noteId)}`,
    }).then(unwrap);
  }

  /** A blank document, stored at once so autosave has something to write into. */
  createEmptyNote(sessionId: string): Promise<Note> {
    return this.bridge.request<Note>({ method: 'POST',
      path: `/sessions/${encodeURIComponent(sessionId)}/notes/empty`,
    }).then(unwrap);
  }

  /** Every note of one session, for the "open existing" picker. */
  listNotes(sessionId: string): Promise<{ notes: Note[] }> {
    return this.bridge.request<{ notes: Note[] }>({ method: 'GET',
      path: `/sessions/${encodeURIComponent(sessionId)}/notes`,
    }).then(unwrap);
  }

  /** Generation never replaces existing text: a new note always opens in a new tab. */
  generateNotes(sessionId: string, language?: string, detail?: NoteDetail): Promise<Note> {
    const body = { ...(language ? { language } : {}), ...(detail ? { detail } : {}) };
    return this.bridge
      .request<Note>({
        method: 'POST',
        path: `/sessions/${encodeURIComponent(sessionId)}/notes`,
        body,
      })
      .then(unwrap);
  }

  /**
   * Write a replacement for one selected passage, storing nothing.
   *
   * The span is character offsets into the note's stored Markdown, and the
   * revision they were read from travels with them: offsets into a document that
   * has since changed point at different text, so the backend checks the pair
   * rather than trusting it.
   */
  rewritePassage(
    sessionId: string, note: Note, start: number, end: number, detail?: NoteDetail,
  ): Promise<RewritePreview> {
    return this.bridge.request<RewritePreview>({ method: 'POST',
      path: `/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(note.id!)}/rewrite`,
      body: { start, end, expected_revision: note.revision, ...(detail ? { detail } : {}) },
    }).then(unwrap);
  }

  /** Put an accepted replacement into the note, as one whole new revision. */
  applyRewrite(sessionId: string, noteId: string, previewId: string): Promise<Note> {
    return this.bridge.request<Note>({ method: 'POST',
      path: `/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(noteId)}/rewrite/apply`,
      body: { preview_id: previewId },
    }).then(unwrap);
  }

  async fetchAudio(sessionId: string, sequence: number): Promise<ArrayBuffer> {
    const res = await this.bridge.fetchAudio(sessionId, sequence);
    if (!res.ok) throw new ApiError(res.status, res.detail);
    return res.data;
  }
}
