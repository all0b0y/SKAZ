import { vi } from 'vitest';
import type { BridgeApi, BridgeRequest, JsonResponse } from '../api/bridge';
import type { AgentView, CodexChat, CodexConnection, CodexPreview, CodexSettings, CodexTask, GroupScope } from '../api/codex';
import type { Message, Note } from '../api/types';
import { validateBridgeRequest } from '../../../electron/ipcPolicy';

// Authored in-memory stand-in for the Codex HTTP boundary, shaped after
// .dev/docs/CODEX-UI-CONTRACT.md. It proves UI mechanics against the contract
// as written — NOT that the real backend or Codex behave this way.

export interface FakeCodex {
  bridge: BridgeApi;
  chats: CodexChat[];
  messages: Record<string, Message[]>;
  tasks: CodexTask[];
  previews: CodexPreview[];
  notes: Note[];
  settings: CodexSettings;
  connection: CodexConnection;
  /** Engine verdicts per purpose; omitted from the state like an older backend when unset. */
  agent?: AgentView;
  selected: Record<string, string | null>;
  /** The backend's verdict on a Group chat for the open session. */
  groupScope: GroupScope;
  calls: { method: string; path: string; body?: unknown; query?: unknown }[];
  /** Next POST .../messages answers with this error once. */
  failNextSend: { status: number; detail: string } | null;
  failApply: { status: number; detail: string } | null;
  task: (id: string) => CodexTask;
  update: (id: string, patch: Partial<CodexTask>) => void;
}

const ok = <T,>(data: T): JsonResponse<T> => ({ ok: true, status: 200, data });
const fail = (status: number, detail: string): JsonResponse<never> => ({ ok: false, status, detail });

export function fakeCodex(init: Partial<Pick<FakeCodex, 'settings' | 'connection'>> = {}): FakeCodex {
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  const fake: FakeCodex = {
    bridge: undefined as unknown as BridgeApi,
    chats: [],
    groupScope: 'available',
    messages: {},
    tasks: [],
    previews: [],
    notes: [],
    settings: init.settings ?? {
      assistant_enabled: true, notes_enabled: true, assistant_model: 'gpt-x', assistant_effort: 'medium',
      notes_model: 'gpt-x', notes_effort: 'high', ask_before_large: true,
    },
    connection: init.connection ?? {
      status: 'connected', version: '0.99.0', web_available: false, install_available: false, error: null,
      login: 'idle', models: [{ id: 'gpt-x', label: 'GPT X', efforts: ['low', 'medium', 'high'] }],
    },
    selected: {},
    calls: [],
    failNextSend: null,
    failApply: null,
    task: (taskId) => fake.tasks.find((t) => t.id === taskId)!,
    update: (taskId, patch) => { Object.assign(fake.task(taskId), patch); },
  };

  const newTask = (chatId: string, question: string, kind: 'chat' | 'notes', sessionIds: string[]): CodexTask => ({
    id: id('t'), chat_id: chatId, session_ids: sessionIds, question, model: 'gpt-x', status: 'queued',
    snapshot_id: null, answer: '', error: null, kind, note_id: null, citations: [], activity: [],
  });

  const handle = (req: BridgeRequest): JsonResponse<unknown> => {
    fake.calls.push({ method: req.method, path: req.path, body: req.body, query: req.query });
    // The main process's gate: a request the real app refuses must fail here too.
    const refused = validateBridgeRequest(req);
    if (refused) return fail(0, refused);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = req.path;
    let m: RegExpMatchArray | null;
    if (req.method === 'GET' && p === '/codex/state') {
      const sid = String(req.query?.session_id ?? '');
      return ok({ chats: fake.chats.filter((c) => c.session_id === sid), selected_chat_id: fake.selected[sid] ?? null,
        group_scope: fake.groupScope, tasks: fake.tasks.map((t) => ({ ...t })), settings: { ...fake.settings }, connection: { ...fake.connection },
        ...(fake.agent ? { agent: fake.agent } : {}) });
    }
    if (req.method === 'POST' && p === '/codex/chats') {
      if (body.scope === 'group' && fake.groupScope !== 'available') return fail(409, 'This session isn’t in a group.');
      const chat: CodexChat = { id: id('c'), session_id: String(body.session_id), title: 'New chat',
        scope: body.scope as CodexChat['scope'], group_id: body.scope === 'group' ? 'g1' : null,
        revoked: false, unread: false, updated_at: `2026-09-24T10:00:${String(seq).padStart(2, '0')}Z` };
      fake.chats.push(chat);
      fake.messages[chat.id] = [];
      return ok(chat);
    }
    if ((m = p.match(/^\/codex\/chats\/([^/]+)$/))) {
      const chat = fake.chats.find((c) => c.id === m![1]);
      if (!chat) return fail(404, 'Chat not found');
      if (req.method === 'GET') {
        return ok({ chat: { ...chat }, messages: [...(fake.messages[chat.id] ?? [])],
          tasks: fake.tasks.filter((t) => t.chat_id === chat.id).map((t) => ({ ...t })) });
      }
      if (req.method === 'PATCH') {
        if (typeof body.title === 'string') chat.title = body.title;
        if (body.selected) { fake.selected[chat.session_id] = chat.id; chat.unread = false; }
        return ok({ ...chat });
      }
      if (req.method === 'DELETE') {
        if (req.query?.confirmed !== true) return fail(400, 'Confirmation required');
        for (const t of fake.tasks) if (t.chat_id === chat.id && ['queued', 'running', 'preparing'].includes(t.status)) t.status = 'cancelled';
        fake.chats = fake.chats.filter((c) => c.id !== chat.id);
        return ok({ deleted: true });
      }
    }
    if (req.method === 'POST' && (m = p.match(/^\/codex\/chats\/([^/]+)\/messages$/))) {
      const chat = fake.chats.find((c) => c.id === m![1]);
      if (!chat) return fail(404, 'Chat not found');
      if (fake.failNextSend) { const f = fake.failNextSend; fake.failNextSend = null; return fail(f.status, f.detail); }
      if (chat.revoked) return fail(409, 'Chat access revoked');
      const own = fake.tasks.find((t) => t.chat_id === chat.id && ['preparing', 'queued', 'running', 'paused', 'stopping'].includes(t.status));
      if (own?.status === 'running') {
        fake.messages[chat.id]!.push({ id: id('m'), role: 'user', content: String(body.question), created_at: 't' });
        return ok({ ...own });
      }
      if (own) return fail(409, 'Chat is busy');
      fake.messages[chat.id]!.push({ id: id('m'), role: 'user', content: String(body.question), created_at: 't' });
      const task = newTask(chat.id, String(body.question), 'chat', [chat.session_id]);
      fake.tasks.push(task);
      return ok({ ...task });
    }
    if (req.method === 'POST' && (m = p.match(/^\/codex\/tasks\/([^/]+)\/(stop|resume)$/))) {
      const task = fake.tasks.find((t) => t.id === m![1]);
      if (!task) return fail(404, 'Task not found');
      if (m[2] === 'stop') task.status = task.status === 'running' ? 'stopping' : 'cancelled';
      else if (task.status === 'paused' || task.status === 'failed') { task.status = 'queued'; task.error = null; }
      else return fail(409, 'Task cannot resume');
      return ok({ ...task });
    }
    if (req.method === 'POST' && (m = p.match(/^\/codex\/sessions\/([^/]+)\/notes$/))) {
      const task = newTask('', '', 'notes', [m[1]!]);
      fake.tasks.push(task);
      return ok({ ...task });
    }
    if (req.method === 'PUT' && p === '/codex/settings') {
      fake.settings = { ...(body as unknown as CodexSettings) };
      return ok({ ...fake.settings });
    }
    if (req.method === 'POST' && p === '/codex/connection/check') return ok({ ...fake.connection });
    if (req.method === 'POST' && p === '/codex/connection/login') {
      if (body.consent !== true) return fail(400, 'Consent required');
      // The browser page is open; the test decides how it ends.
      fake.connection = { ...fake.connection, login: 'pending', error: null };
      return ok({ auth_url: 'https://auth.openai.com/authorize?fixture=1' });
    }
    if (req.method === 'POST' && p === '/codex/connection/logout') {
      fake.connection = { ...fake.connection, status: 'signed_out', models: [], login: 'idle' };
      return ok({ ...fake.connection });
    }
    if (req.method === 'GET' && p === '/codex/previews') {
      return ok({ previews: fake.previews.filter((pv) => pv.chat_id === req.query?.chat_id).map((pv) => ({ ...pv })) });
    }
    if (req.method === 'POST' && (m = p.match(/^\/codex\/previews\/([^/]+)\/(apply|discard)$/))) {
      const preview = fake.previews.find((pv) => pv.id === m![1]);
      if (!preview) return fail(404, 'Preview not found');
      if (m[2] === 'discard') { fake.previews = fake.previews.filter((pv) => pv !== preview); return ok({ deleted: true }); }
      if (body.confirmed !== true) return fail(400, 'Confirmation required');
      if (fake.failApply) return fail(fake.failApply.status, fake.failApply.detail);
      preview.status = 'applied';
      const note = fake.notes.find((n) => n.id === preview.note_id)!;
      note.content = note.content.replace(preview.original, preview.replacement);
      note.revision = (note.revision ?? 1) + 1;
      return ok({ ...note });
    }
    if (req.method === 'GET' && (m = p.match(/^\/sessions\/([^/]+)\/notes$/))) return ok({ notes: fake.notes.map((n) => ({ ...n })) });
    return fail(404, 'Not Found');
  };

  fake.bridge = {
    request: vi.fn(async (req: BridgeRequest) => handle(req)),
    uploadAudio: vi.fn(), bufferAudio: vi.fn(), openNative: vi.fn(), sendNativeAudio: vi.fn(), endNative: vi.fn(),
    onNativeFailure: vi.fn(() => () => undefined), chooseAudioFile: vi.fn(async () => null),
    getBackendStatus: vi.fn(async () => ({ phase: 'ready' as const })),
    onBackendStatus: vi.fn(() => () => undefined),
    reportCodexActivity: vi.fn(),
    platform: 'test',
  } as unknown as BridgeApi;
  return fake;
}
