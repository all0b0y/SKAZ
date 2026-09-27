// Codex Assistant / Notes boundary (.dev/docs/CODEX-UI-CONTRACT.md).
//
// Wire shapes mirror the contract: snake_case, opaque string IDs. Extra backend
// fields are tolerated. Every call goes through the same authenticated preload
// bridge as the rest of the app; none of these methods starts a model turn,
// logs in, or installs anything on its own — each is tied to an explicit user
// action by the caller.

import type { BridgeApi, JsonResponse } from './bridge';
import type { Citation, Message, Note, NoteDetail } from './types';
import { ApiError } from './client';

export type CodexScope = 'session' | 'group' | 'all';

export type CodexTaskStatus =
  | 'preparing' | 'queued' | 'running' | 'stopping' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface CodexChat {
  id: string;
  session_id: string;
  title: string;
  scope: CodexScope;
  group_id: string | null;
  /** Source removed or left the scope: view only, no send/resume/apply. */
  revoked: boolean;
  unread: boolean;
  updated_at: string;
}

export interface CodexTask {
  id: string;
  chat_id: string;
  session_ids: string[];
  question: string;
  model: string;
  status: CodexTaskStatus;
  snapshot_id: string | null;
  /** Cumulative replacement, never appended to. */
  answer: string;
  error: string | null;
  kind: 'chat' | 'notes';
  note_id: string | null;
  citations: Citation[];
  /** Actual tool work, not reasoning. */
  activity: string[];
  /** This run started over after an interruption; the old draft was discarded. */
  restarted?: boolean;
  /** What runs the task: Codex, or the API profile as a tool-driven agent. Absent = Codex. */
  engine?: 'codex' | 'api';
  /** `codex`, or the API provider of an agent-mode task. */
  provider?: string;
}

/** The two jobs that can each run on Codex or on their own API profile. */
export type CodexPurpose = 'assistant' | 'notes';

export interface CodexSettings {
  /** Assistant runs on Codex; otherwise on its API profile. Independent of Notes. */
  assistant_enabled: boolean;
  /** Notes run on Codex; otherwise on their API profile. Independent of Assistant. */
  notes_enabled: boolean;
  assistant_model: string;
  assistant_effort: string;
  notes_model: string;
  notes_effort: string;
  ask_before_large: boolean;
  /** With Codex off: the Assistant API profile reads the library with SKAZ tools (agent mode). */
  assistant_api_agent?: boolean;
  /** With Codex off: the Notes API profile reads the transcript with SKAZ tools (agent mode). */
  notes_api_agent?: boolean;
}

/** The settings keys that belong to one purpose. */
export const PURPOSE_KEYS = {
  assistant: {
    enabled: 'assistant_enabled', model: 'assistant_model', effort: 'assistant_effort', apiAgent: 'assistant_api_agent',
  },
  notes: { enabled: 'notes_enabled', model: 'notes_model', effort: 'notes_effort', apiAgent: 'notes_api_agent' },
} as const satisfies Record<CodexPurpose, Record<string, keyof CodexSettings>>;

export interface CodexModel {
  id: string;
  label: string;
  efforts: string[];
}

export type CodexConnectionStatus =
  | 'unchecked' | 'checking' | 'missing' | 'incompatible' | 'signed_out' | 'connected' | 'error';

/**
 * The official browser login: `pending` while its page is open, otherwise how
 * the last attempt ended without an account. Success shows as `connected`.
 */
export type CodexLoginState = 'idle' | 'pending' | 'failed' | 'cancelled' | 'timed_out';

export interface CodexConnection {
  status: CodexConnectionStatus;
  version: string | null;
  models: CodexModel[];
  error: string | null;
  web_available: boolean;
  install_available: boolean;
  /** Absent from a backend that predates observable login. */
  login?: CodexLoginState;
  /** Where the Codex CLI was found; null when missing or not yet checked. */
  path?: string | null;
  /** A sign-in happened with consent before, so re-login needs no checkbox. */
  relogin_available?: boolean;
}

export interface CodexPreview {
  id: string;
  chat_id: string;
  session_id: string;
  note_id: string;
  expected_revision: number;
  original: string;
  replacement: string;
  status: 'pending' | 'applied' | 'discarded';
}

/** Whether a purpose's API profile can run as an agent, and if not, why. */
export interface ApiAgentStatus {
  provider: string;
  model: string;
  available: boolean;
  reason: string | null;
}

/**
 * The engine that answers a purpose: Codex, the API profile with SKAZ tools
 * (`api_agent`), or the one-pass API path (`api`).
 */
export type PurposeEngine = 'codex' | 'api_agent' | 'api';

export interface PurposeAgentView {
  engine: PurposeEngine;
  api_agent: ApiAgentStatus | null;
}

export type AgentView = Record<CodexPurpose, PurposeAgentView>;

export interface CodexState {
  chats: CodexChat[];
  selected_chat_id: string | null;
  tasks: CodexTask[];
  settings: CodexSettings;
  connection: CodexConnection;
  /** Absent from a backend without agent mode for API providers. */
  agent?: AgentView;
}

export interface CodexChatDetail {
  chat: CodexChat;
  messages: Message[];
  tasks: CodexTask[];
}

/** A task the global slot still owns or will own: it can be stopped. */
export const ACTIVE_STATUSES: readonly CodexTaskStatus[] = ['preparing', 'queued', 'running', 'stopping'];
export const isActive = (task: Pick<CodexTask, 'status'>): boolean => ACTIVE_STATUSES.includes(task.status);
/** Ended without a complete answer: its partial text must never read as final. */
export const isUnfinished = (task: Pick<CodexTask, 'status'>): boolean =>
  task.status === 'paused' || task.status === 'failed' || task.status === 'cancelled';

function unwrap<T>(res: JsonResponse<T>): T {
  if (!res.ok) throw new ApiError(res.status, res.detail);
  return res.data;
}

/** The response is the contract's shape, or the boundary is not what we expect. */
function requireShape<T>(value: T, check: (v: T) => boolean, what: string): T {
  if (!check(value)) throw new ApiError(0, `Unexpected ${what} response from the Codex boundary`);
  return value;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isState = (v: unknown): boolean => isObject(v) && Array.isArray(v.chats) && Array.isArray(v.tasks)
  && isObject(v.settings) && isObject(v.connection);
const isChat = (v: unknown): boolean => isObject(v) && typeof v.id === 'string' && typeof v.scope === 'string';
const isTask = (v: unknown): boolean => isObject(v) && typeof v.id === 'string' && typeof v.status === 'string';

/**
 * Settings as the renderer uses them. A document with only the single legacy
 * `enabled` flag meant "Codex for both", so it fills whichever per-purpose flag
 * is missing; the legacy key itself is dropped and never sent back.
 */
export function normalizeSettings(raw: CodexSettings & { enabled?: unknown }): CodexSettings {
  const { enabled: legacy, ...settings } = raw;
  const fallback = legacy === true;
  return {
    ...settings,
    assistant_enabled: typeof settings.assistant_enabled === 'boolean' ? settings.assistant_enabled : fallback,
    notes_enabled: typeof settings.notes_enabled === 'boolean' ? settings.notes_enabled : fallback,
  };
}

const enc = encodeURIComponent;

export class CodexClient {
  constructor(private readonly bridge: BridgeApi) {}

  /** Reads persisted state only; the contract forbids provider calls on this GET. */
  state(sessionId: string | null): Promise<CodexState> {
    return this.bridge.request<CodexState>({
      method: 'GET', path: '/codex/state', ...(sessionId ? { query: { session_id: sessionId } } : {}),
    }).then(unwrap).then((s) => requireShape(s, isState, 'state'))
      .then((s) => ({ ...s, settings: normalizeSettings(s.settings) }));
  }

  createChat(sessionId: string, scope: CodexScope): Promise<CodexChat> {
    return this.bridge.request<CodexChat>({ method: 'POST', path: '/codex/chats', body: { session_id: sessionId, scope } })
      .then(unwrap).then((c) => requireShape(c, isChat, 'chat'));
  }

  chat(chatId: string): Promise<CodexChatDetail> {
    return this.bridge.request<CodexChatDetail>({ method: 'GET', path: `/codex/chats/${enc(chatId)}` })
      .then(unwrap)
      .then((d) => requireShape(d, (v) => isObject(v) && isChat(v.chat) && Array.isArray(v.messages)
        && Array.isArray(v.tasks), 'chat detail'));
  }

  renameChat(chatId: string, title: string): Promise<CodexChat> {
    return this.bridge.request<CodexChat>({ method: 'PATCH', path: `/codex/chats/${enc(chatId)}`, body: { title } })
      .then(unwrap);
  }

  selectChat(chatId: string): Promise<CodexChat> {
    return this.bridge.request<CodexChat>({ method: 'PATCH', path: `/codex/chats/${enc(chatId)}`, body: { selected: true } })
      .then(unwrap);
  }

  /** Permanent: the caller has already shown and received the confirmation. */
  deleteChat(chatId: string): Promise<void> {
    return this.bridge.request<{ deleted: boolean }>({
      method: 'DELETE', path: `/codex/chats/${enc(chatId)}`, query: { confirmed: true },
    }).then(unwrap).then(() => undefined);
  }

  /** Starts a task, or steers the running one of this chat. Never duplicates. */
  send(chatId: string, question: string, confirmedLarge = false): Promise<CodexTask> {
    return this.bridge.request<CodexTask>({
      method: 'POST', path: `/codex/chats/${enc(chatId)}/messages`,
      body: { question, ...(confirmedLarge ? { confirmed_large: true } : {}) },
    }).then(unwrap).then((t) => requireShape(t, isTask, 'task'));
  }

  stop(taskId: string): Promise<CodexTask> {
    return this.bridge.request<CodexTask>({ method: 'POST', path: `/codex/tasks/${enc(taskId)}/stop`, body: {} })
      .then(unwrap);
  }

  /** Manual only: nothing in the UI resumes a task without a click. */
  resume(taskId: string): Promise<CodexTask> {
    return this.bridge.request<CodexTask>({ method: 'POST', path: `/codex/tasks/${enc(taskId)}/resume`, body: {} })
      .then(unwrap);
  }

  generateNotes(sessionId: string, language: string, detail: NoteDetail): Promise<CodexTask> {
    return this.bridge.request<CodexTask>({
      method: 'POST', path: `/codex/sessions/${enc(sessionId)}/notes`, body: { language, detail },
    }).then(unwrap).then((t) => requireShape(t, isTask, 'task'));
  }

  saveSettings(settings: CodexSettings): Promise<CodexSettings> {
    return this.bridge.request<CodexSettings>({ method: 'PUT', path: '/codex/settings', body: settings })
      .then(unwrap).then(normalizeSettings);
  }

  checkConnection(): Promise<CodexConnection> {
    return this.bridge.request<CodexConnection>({ method: 'POST', path: '/codex/connection/check', body: {} })
      .then(unwrap);
  }

  login(): Promise<{ auth_url: string }> {
    return this.bridge.request<{ auth_url: string }>({
      method: 'POST', path: '/codex/connection/login', body: { consent: true },
    }).then(unwrap);
  }

  logout(): Promise<CodexConnection> {
    return this.bridge.request<CodexConnection>({ method: 'POST', path: '/codex/connection/logout', body: {} })
      .then(unwrap);
  }

  previews(chatId: string): Promise<CodexPreview[]> {
    return this.bridge.request<{ previews: CodexPreview[] }>({
      method: 'GET', path: '/codex/previews', query: { chat_id: chatId },
    }).then(unwrap).then((r) => (Array.isArray(r?.previews) ? r.previews : []));
  }

  applyPreview(previewId: string): Promise<Note> {
    return this.bridge.request<Note>({
      method: 'POST', path: `/codex/previews/${enc(previewId)}/apply`, body: { confirmed: true },
    }).then(unwrap);
  }

  discardPreview(previewId: string): Promise<void> {
    return this.bridge.request<{ deleted: boolean }>({
      method: 'POST', path: `/codex/previews/${enc(previewId)}/discard`, body: {},
    }).then(unwrap).then(() => undefined);
  }
}

/** Only an https authorization page may be handed to the OS browser. */
export function isSafeAuthUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}
