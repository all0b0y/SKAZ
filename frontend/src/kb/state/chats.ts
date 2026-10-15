import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  EngineId, KbChat, KbChatEvent, KbChatSummary, KbMessage, KbMessageInput, KbPageRef, KbSendContext,
} from '../api/b2';
import { errorText, type KbClient } from '../api/client';
import type { ActionResult, Load } from './library';
import { longPoll } from './poll';

export interface OpenChat {
  chat: KbChat | null;
  load: Load;
  error: string | null;
}

export interface AgentChoice {
  engine: EngineId;
  model: string | null;
  effort: string | null;
}

export interface ChatsData {
  list: KbChatSummary[];
  listLoad: Load;
  listError: string | null;
  listCursor: number;
  /** Chat in the centre; null = a new, not yet created chat. */
  currentId: string | null;
  chats: Record<string, OpenChat>;
  /** Agent/model/effort picked for the new chat before its first message. */
  draftAgent: AgentChoice | null;
}

export interface ChatsActions {
  loadList: () => Promise<void>;
  /** Keep the list live (answering / new answer indicators). Returns stop. */
  startListPoll: () => () => void;
  open: (id: string | null) => void;
  load: (id: string) => Promise<void>;
  /** Follow one chat's events (streamed text, states, title). Returns stop. */
  follow: (id: string) => () => void;
  /** Create the chat if needed, then send. Resolves with the chat id. */
  send: (input: KbMessageInput, context: KbSendContext) => Promise<ActionResult<string>>;
  stop: (chatId: string, messageId: string) => Promise<ActionResult>;
  regenerate: (chatId: string, messageId: string) => Promise<ActionResult>;
  resume: (chatId: string, messageId: string) => Promise<ActionResult>;
  saveMessage: (chatId: string, messageId: string) => Promise<ActionResult<KbPageRef>>;
  saveChat: (chatId: string) => Promise<ActionResult<KbPageRef>>;
  exportChat: (chatId: string) => Promise<ActionResult<{ file_name: string; markdown: string }>>;
  rename: (chatId: string, title: string) => Promise<ActionResult>;
  setPinned: (chatId: string, pinned: boolean) => Promise<ActionResult>;
  remove: (chatId: string) => Promise<ActionResult>;
  markRead: (chatId: string) => Promise<void>;
  /** Change agent/model/effort; on an existing chat the backend records it (409 = not available). */
  setAgent: (chatId: string | null, choice: AgentChoice) => Promise<ActionResult>;
  setDraftAgent: (choice: AgentChoice | null) => void;
}

export type ChatsStore = StoreApi<ChatsData & ChatsActions>;

const byUpdated = (a: KbChatSummary, b: KbChatSummary) => b.updated_at.localeCompare(a.updated_at);

function summaryOf(chat: KbChat): KbChatSummary {
  const { messages: _m, cursor: _c, ...rest } = chat;
  void _m; void _c;
  return rest;
}

/** True while an answer in this chat is still being written. */
export function isAnswering(chat: Pick<KbChat, 'messages'> | null): boolean {
  return !!chat && chat.messages.some((m) => m.role === 'assistant' && m.state === 'streaming');
}

function upsertMessage(messages: KbMessage[], message: KbMessage): KbMessage[] {
  const i = messages.findIndex((m) => m.id === message.id);
  if (i < 0) return [...messages, message].sort((a, b) => a.seq - b.seq);
  const next = messages.slice();
  next[i] = message;
  return next;
}

/** Apply long-poll events to a chat. A `message` event is a full snapshot; `delta` appends text. */
export function applyEvents(chat: KbChat, events: KbChatEvent[]): KbChat {
  let messages = chat.messages;
  let title = chat.title;
  for (const e of events) {
    if (e.type === 'title') {
      if (e.text) title = e.text;
      continue;
    }
    if ((e.type === 'message' || e.type === 'state') && e.message) {
      messages = upsertMessage(messages, e.message);
      continue;
    }
    const i = messages.findIndex((m) => m.id === e.message_id);
    if (i < 0) continue;
    const m = messages[i]!;
    let next: KbMessage = m;
    if (e.type === 'delta' && e.text) {
      const parts = m.parts.slice();
      const last = parts[parts.length - 1];
      if (last && last.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + e.text };
      else parts.push({ type: 'text', text: e.text });
      next = { ...m, parts };
    } else if (e.type === 'part' && e.part) {
      next = { ...m, parts: [...m.parts, e.part] };
    } else if (e.type === 'state' && e.text) {
      next = { ...m, state: e.text as KbMessage['state'] };
    }
    messages = messages.slice();
    messages[i] = next;
  }
  const cursor = events.reduce((acc, e) => Math.max(acc, e.seq), chat.cursor);
  return { ...chat, title, messages, cursor, state: isAnswering({ messages }) ? 'answering' : 'idle' };
}

export function createChatsStore(client: KbClient): ChatsStore {
  return createStore<ChatsData & ChatsActions>()((set, get) => {
    const putChat = (chat: KbChat) => {
      set((s) => ({
        chats: { ...s.chats, [chat.id]: { chat, load: 'ready', error: null } },
        list: [summaryOf(chat), ...s.list.filter((c) => c.id !== chat.id)].sort(byUpdated),
      }));
    };
    const patchSummary = (id: string, patch: Partial<KbChatSummary>) => {
      set((s) => {
        const open = s.chats[id];
        return {
          list: s.list.map((c) => (c.id === id ? { ...c, ...patch } : c)),
          chats: open?.chat ? { ...s.chats, [id]: { ...open, chat: { ...open.chat, ...patch } } } : s.chats,
        };
      });
    };
    const merge = (id: string, messages: KbMessage[]) => {
      const open = get().chats[id];
      if (!open?.chat) return;
      let next = open.chat.messages;
      for (const m of messages) next = upsertMessage(next, m);
      const chat = { ...open.chat, messages: next, state: isAnswering({ messages: next }) ? 'answering' as const : 'idle' as const };
      set((s) => ({ chats: { ...s.chats, [id]: { ...open, chat } }, list: s.list.map((c) => (c.id === id ? { ...c, state: chat.state } : c)) }));
    };
    const act = async <T,>(fn: () => Promise<T>): Promise<ActionResult<T>> => {
      try {
        return { ok: true, value: await fn() };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    };

    return {
      list: [],
      listLoad: 'idle',
      listError: null,
      listCursor: 0,
      currentId: null,
      chats: {},
      draftAgent: null,

      loadList: async () => {
        set({ listLoad: get().listLoad === 'ready' ? 'ready' : 'loading', listError: null });
        try {
          const list = await client.call('GET /kb/chats');
          set({ list: [...list].sort(byUpdated), listLoad: 'ready' });
        } catch (error) {
          set({ listLoad: 'error', listError: errorText(error) });
        }
      },

      startListPoll: () => longPoll(async (cursor, wait) => {
        const res = await client.call('GET /kb/chats/events', { query: { after: cursor, wait } });
        if (res.chats.length) {
          set((s) => {
            const byId = new Map(s.list.map((c) => [c.id, c]));
            for (const c of res.chats) byId.set(c.id, c);
            const chats = { ...s.chats };
            for (const c of res.chats) {
              const open = chats[c.id];
              if (open?.chat) chats[c.id] = { ...open, chat: { ...open.chat, title: c.title, pinned: c.pinned, unread: c.unread } };
            }
            return { list: [...byId.values()].sort(byUpdated), chats };
          });
        }
        set({ listCursor: res.cursor });
        return { cursor: res.cursor, changed: res.chats.length > 0 };
      }, get().listCursor),

      open: (id) => {
        set({ currentId: id });
        if (id && !get().chats[id]) void get().load(id);
      },

      load: async (id) => {
        set((s) => ({ chats: { ...s.chats, [id]: { chat: s.chats[id]?.chat ?? null, load: 'loading', error: null } } }));
        try {
          const chat = await client.call('GET /kb/chats/{chat_id}', { path: { chat_id: id } });
          set((s) => ({ chats: { ...s.chats, [id]: { chat, load: 'ready', error: null } } }));
        } catch (error) {
          set((s) => ({ chats: { ...s.chats, [id]: { chat: s.chats[id]?.chat ?? null, load: 'error', error: errorText(error) } } }));
        }
      },

      follow: (id) => longPoll(async (_cursor, wait) => {
        const open = get().chats[id];
        if (!open?.chat) return { cursor: 0, changed: false };
        const after = open.chat.cursor;
        const res = await client.call('GET /kb/chats/{chat_id}/events', { path: { chat_id: id }, query: { after, wait } });
        const now = get().chats[id];
        if (!now?.chat) return { cursor: res.cursor, changed: false };
        const fresh = res.events.filter((e) => e.seq > now.chat!.cursor);
        if (fresh.length) {
          const chat = applyEvents(now.chat, fresh);
          set((s) => ({
            chats: { ...s.chats, [id]: { ...now, chat } },
            list: s.list.map((c) => (c.id === id ? { ...c, title: chat.title, state: chat.state } : c)),
          }));
        }
        return { cursor: res.cursor, changed: fresh.length > 0 };
      }, 0),

      send: async (input, context) => {
        let id = get().currentId;
        if (!id) {
          const draft = get().draftAgent;
          try {
            const chat = await client.call('POST /kb/chats', {
              body: draft ? { engine: draft.engine, model: draft.model, effort: draft.effort } : {},
            });
            putChat(chat);
            id = chat.id;
            set({ currentId: id, draftAgent: null });
          } catch (error) {
            return { ok: false, error: errorText(error) };
          }
        }
        const chatId = id;
        try {
          const res = await client.call('POST /kb/chats/{chat_id}/messages', {
            path: { chat_id: chatId },
            body: { text: input.text, mentions: input.mentions, quotes: input.quotes, attachments: input.attachments, context },
          });
          merge(chatId, [res.user, res.assistant]);
          patchSummary(chatId, { updated_at: res.user.created_at });
          set((s) => ({ list: [...s.list].sort(byUpdated) }));
          return { ok: true, value: chatId };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      stop: (chatId, messageId) => act(async () => {
        const m = await client.call('POST /kb/chats/{chat_id}/messages/{message_id}/stop', { path: { chat_id: chatId, message_id: messageId } });
        merge(chatId, [m]);
      }),
      regenerate: (chatId, messageId) => act(async () => {
        const res = await client.call('POST /kb/chats/{chat_id}/messages/{message_id}/regenerate', { path: { chat_id: chatId, message_id: messageId } });
        merge(chatId, [res.assistant]);
      }),
      resume: (chatId, messageId) => act(async () => {
        const res = await client.call('POST /kb/chats/{chat_id}/messages/{message_id}/resume', { path: { chat_id: chatId, message_id: messageId } });
        merge(chatId, [res.assistant]);
      }),
      saveMessage: (chatId, messageId) => act(async () => {
        const ref = await client.call('POST /kb/chats/{chat_id}/messages/{message_id}/save', { path: { chat_id: chatId, message_id: messageId } });
        const open = get().chats[chatId];
        const m = open?.chat?.messages.find((x) => x.id === messageId);
        if (m) merge(chatId, [{ ...m, saved_page_id: ref.id }]);
        return ref;
      }),
      saveChat: (chatId) => act(() => client.call('POST /kb/chats/{chat_id}/save', { path: { chat_id: chatId } })),
      exportChat: (chatId) => act(() => client.call('GET /kb/chats/{chat_id}/export', { path: { chat_id: chatId } })),
      rename: (chatId, title) => act(async () => {
        const s = await client.call('PATCH /kb/chats/{chat_id}', { path: { chat_id: chatId }, body: { title } });
        patchSummary(chatId, { title: s.title });
      }),
      setPinned: (chatId, pinned) => act(async () => {
        const s = await client.call('PATCH /kb/chats/{chat_id}', { path: { chat_id: chatId }, body: { pinned } });
        patchSummary(chatId, { pinned: s.pinned });
      }),
      remove: (chatId) => act(async () => {
        await client.call('DELETE /kb/chats/{chat_id}', { path: { chat_id: chatId } });
        set((s) => {
          const chats = { ...s.chats };
          delete chats[chatId];
          return { list: s.list.filter((c) => c.id !== chatId), chats, currentId: s.currentId === chatId ? null : s.currentId };
        });
      }),
      markRead: async (chatId) => {
        if (!get().list.find((c) => c.id === chatId)?.unread) return;
        patchSummary(chatId, { unread: false });
        try {
          await client.call('POST /kb/chats/{chat_id}/read', { path: { chat_id: chatId } });
        } catch {
          /* The indicator comes back with the next list event if the backend did not record it. */
        }
      },
      setAgent: async (chatId, choice) => {
        if (!chatId) {
          set({ draftAgent: choice });
          return { ok: true, value: undefined };
        }
        return act(async () => {
          const s = await client.call('PATCH /kb/chats/{chat_id}', {
            path: { chat_id: chatId }, body: { engine: choice.engine, model: choice.model, effort: choice.effort },
          });
          patchSummary(chatId, { engine: s.engine, model: s.model, effort: s.effort });
        });
      },
      setDraftAgent: (choice) => set({ draftAgent: choice }),
    };
  });
}
