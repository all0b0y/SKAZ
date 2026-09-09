import type {
  AudioUploadMeta,
  BridgeApi,
  JsonResponse,
} from './bridge';
import type {
  AskRequest,
  AskResponse,
  AudioIngestResponse,
  ModelsResponse,
  Note,
  Session,
  SessionDetail,
  SessionStatus,
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

  listSessions(): Promise<Session[]> {
    return this.bridge
      .request<{ sessions: Session[] }>({ method: 'GET', path: '/sessions' })
      .then(unwrap)
      .then((r) => r.sessions);
  }

  createSession(title: string): Promise<Session> {
    return this.bridge
      .request<Session>({ method: 'POST', path: '/sessions', body: { title } })
      .then(unwrap);
  }

  getSession(id: string): Promise<SessionDetail> {
    return this.bridge
      .request<SessionDetail>({ method: 'GET', path: `/sessions/${encodeURIComponent(id)}` })
      .then(unwrap);
  }

  setSessionStatus(id: string, status: SessionStatus, title?: string): Promise<Session> {
    const body: { status: SessionStatus; title?: string } = { status };
    if (title !== undefined) body.title = title;
    return this.bridge
      .request<Session>({ method: 'PATCH', path: `/sessions/${encodeURIComponent(id)}`, body })
      .then(unwrap);
  }

  renameSession(id: string, title: string, status: SessionStatus): Promise<Session> {
    return this.setSessionStatus(id, status, title);
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
