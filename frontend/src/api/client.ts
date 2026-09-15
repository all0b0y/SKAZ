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
  Session,
  SessionDetail,
  SessionStatus,
  SessionMode,
  SessionStatusOptions,
  Settings,
  SettingsUpdate,
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

function unwrap<T>(res: JsonResponse<T>): T {
  if (!res.ok) throw new ApiError(res.status, res.detail);
  return res.data;
}

// Typed wrapper over the preload bridge. All methods speak the docs/API.md
// contract (snake_case wire shapes) and throw ApiError on any non-2xx.
export class ApiClient {
  constructor(private readonly bridge: BridgeApi) {}

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

  generateNotes(sessionId: string, language?: string): Promise<Note> {
    const body = language ? { language } : {};
    return this.bridge
      .request<Note>({
        method: 'POST',
        path: `/sessions/${encodeURIComponent(sessionId)}/notes`,
        body,
      })
      .then(unwrap);
  }

  async fetchAudio(sessionId: string, sequence: number): Promise<ArrayBuffer> {
    const res = await this.bridge.fetchAudio(sessionId, sequence);
    if (!res.ok) throw new ApiError(res.status, res.detail);
    return res.data;
  }
}
