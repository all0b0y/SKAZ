import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbChat, KbChatEvent, KbChatSummary, KbMessage, KbMessageInput, KbOpenContext, KbSavedAnalysis } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { errorText, type KbClient } from '../api/client';
import type { ActionResult, Load } from './library';
import { longPoll } from './poll';
import {
  answerQuestion, decidePermission, isWaitingPart, partsOf, undoPermission,
  type AnyMessagePart, type KbChatEventP, type KbChatSummaryP, type KbPermissionDecision, type KbPermissionPart,
  type KbQuestionAnswer, type KbQuestionPart,
} from '../api/permissions';

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
  /** How the user answered a permission request in this window (to say «Allowed in this chat»). */
  decisions: Record<string, KbPermissionDecision['decision']>;
}

export interface ChatsActions {
  loadList: () => Promise<void>;
  /** Keep the list live (answering / new answer indicators). Returns stop. */
  startListPoll: () => () => void;
  open: (id: string | null) => void;
  load: (id: string) => Promise<void>;
  /** Follow one chat's events (streamed text, states, title). Returns stop. */
  follow: (id: string) => () => void;
  /** Create the chat if needed (or always, with `newChat`), then send. Resolves with the chat id. */
  send: (input: KbMessageInput, context: KbOpenContext, options?: { newChat?: boolean }) => Promise<ActionResult<string>>;
  stop: (chatId: string, messageId: string) => Promise<ActionResult>;
  regenerate: (chatId: string, messageId: string) => Promise<ActionResult>;
  /** Your question changed in place: the messages after it go and it is answered again (409 while answering). */
  edit: (chatId: string, messageId: string, input: KbMessageInput) => Promise<ActionResult>;
  resume: (chatId: string, messageId: string) => Promise<ActionResult>;
  /** The page written; `warning` names what was left out (a diagram without material quotes). */
  saveMessage: (chatId: string, messageId: string) => Promise<ActionResult<KbSavedAnalysis>>;
  saveChat: (chatId: string) => Promise<ActionResult<KbSavedAnalysis>>;
  exportChat: (chatId: string) => Promise<ActionResult<{ file_name: string; markdown: string }>>;
  rename: (chatId: string, title: string) => Promise<ActionResult>;
  setPinned: (chatId: string, pinned: boolean) => Promise<ActionResult>;
  remove: (chatId: string) => Promise<ActionResult>;
  markRead: (chatId: string) => Promise<void>;
  /** Change agent/model/effort; on an existing chat the backend records it (409 = not available). */
  setAgent: (chatId: string | null, choice: AgentChoice) => Promise<ActionResult>;
  setDraftAgent: (choice: AgentChoice | null) => void;
  /** A material or page was deleted: mark it gone in every loaded chat (see `forgetInChat`). */
  forget: (gone: Gone) => void;
  /** Answer an agent's permission request (0.3.1 P); the card shows the returned part. */
  decide: (chatId: string, partId: string, body: KbPermissionDecision) => Promise<ActionResult<KbPermissionPart>>;
  /** Undo a change allowed without a question; 409 = the page changed since (reason in words). */
  undo: (chatId: string, partId: string) => Promise<ActionResult<KbPermissionPart>>;
  /** Answer an agent's question by option or own text (also a late pick after writing instead). */
  answer: (chatId: string, partId: string, body: KbQuestionAnswer) => Promise<ActionResult<KbQuestionPart>>;
  /** A part as the backend answered it (a study block after a grade, 0.3.1 S): replaced in place. */
  applyPart: (chatId: string, part: AnyMessagePart) => void;
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

/** What is gone from the library: chips to it in already loaded answers stop pointing at it. */
export interface Gone {
  material?: string;
  page?: string;
}

/**
 * A deleted material or page, in the answers of a chat already on screen (QA D4/B9/D5): its
 * citations become "no longer available" and its page chips "removed", exactly as a fresh read
 * from the backend would show them — no reload needed. Untouched messages keep their identity.
 */
export function forgetInChat(chat: KbChat, gone: Gone): KbChat {
  const cite = <T extends { material_id: string; available: boolean }>(c: T): T =>
    (gone.material && c.material_id === gone.material && c.available ? { ...c, available: false } : c);
  let changed = false;
  const messages = chat.messages.map((m) => {
    const parts = m.parts.map((part) => {
      let next = part;
      if (part.type === 'cite') {
        const citation = cite(part.citation);
        if (citation !== part.citation) next = { ...part, citation };
      } else if (part.type === 'connection') {
        const folders = part.folders.map((f) => { const citation = cite(f.citation); return citation === f.citation ? f : { ...f, citation }; });
        const page = gone.page && part.page?.id === gone.page ? null : part.page;
        if (page !== part.page || folders.some((f, i) => f !== part.folders[i])) next = { ...part, folders, page };
      } else if (part.type === 'page' && gone.page && part.page.id === gone.page && part.available !== false) {
        next = { ...part, available: false };
      }
      if (next !== part) changed = true;
      return next;
    });
    return parts.some((p, i) => p !== m.parts[i]) ? { ...m, parts } : m;
  });
  return changed ? { ...chat, messages } : chat;
}

/** The message with the part replaced by the part with the same id (null = no such part). */
export function replacePart(messages: KbMessage[], part: AnyMessagePart, messageId?: string | null): KbMessage[] | null {
  const id = 'id' in part ? part.id : null;
  if (!id) return null;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (messageId && m.id !== messageId) continue;
    const at = partsOf(m).findIndex((p) => 'id' in p && p.id === id);
    if (at < 0) continue;
    const parts = m.parts.slice();
    parts[at] = part as KbMessage['parts'][number];
    const next = messages.slice();
    next[i] = { ...m, parts };
    return next;
  }
  return null;
}

const waitingOf = (chat: Pick<KbChat, 'messages'>): Partial<KbChatSummaryP> => ({ waiting_for_user: chatWaits(chat) });

/** A permission or a question of this chat still waits for the user. */
export function chatWaits(chat: Pick<KbChat, 'messages'>): boolean {
  return chat.messages.some((m) => partsOf(m).some(isWaitingPart));
}

/**
 * Apply long-poll events to a chat. A `message` event is a full snapshot; `delta` appends text;
 * `part_update` (0.3.1 P) replaces the part with the same id.
 */
export function applyEvents(chat: KbChat, events: KbChatEvent[]): KbChat {
  let messages = chat.messages;
  let title = chat.title;
  for (const event of events) {
    const e = event as KbChatEventP;
    if (e.type === 'part_update') {
      if (e.part) messages = replacePart(messages, e.part, e.message_id) ?? messages;
      continue;
    }
    if (e.type === 'removed') {
      messages = messages.filter((m) => m.id !== e.message_id);
      continue;
    }
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
      next = { ...m, parts: [...m.parts, e.part as KbMessage['parts'][number]] };
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
    /**
     * Put a request's answer into its chat. `created`: the new answer the request made (send, edit,
     * regenerate, resume) is returned as it was created, and the long poll may already show more of
     * it (C-19): a copy already here is the same or newer, so it stays.
     */
    const merge = (id: string, messages: KbMessage[], created?: KbMessage) => {
      const open = get().chats[id];
      if (!open?.chat) return;
      let next = open.chat.messages;
      for (const m of messages) next = upsertMessage(next, m);
      if (created && !next.some((m) => m.id === created.id)) next = upsertMessage(next, created);
      const chat = { ...open.chat, messages: next, state: isAnswering({ messages: next }) ? 'answering' as const : 'idle' as const };
      set((s) => ({ chats: { ...s.chats, [id]: { ...open, chat } }, list: s.list.map((c) => (c.id === id ? { ...c, state: chat.state } : c)) }));
    };
    /** A part the backend answered with: in place in its chat; the list's waiting mark follows. */
    const putPart = (chatId: string, part: AnyMessagePart) => {
      const open = get().chats[chatId];
      if (!open?.chat) return;
      const messages = replacePart(open.chat.messages, part);
      if (!messages) return;
      const chat = { ...open.chat, messages };
      const waiting = waitingOf(chat);
      set((s) => ({
        chats: { ...s.chats, [chatId]: { ...open, chat } },
        list: s.list.map((c) => (c.id === chatId ? { ...c, ...waiting } : c)),
      }));
    };
    const supersedeQuestions = (chatId: string) => {
      const open = get().chats[chatId];
      for (const m of open?.chat?.messages ?? []) {
        for (const p of partsOf(m)) if (p.type === 'question' && p.status === 'pending') putPart(chatId, { ...p, status: 'superseded' });
      }
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
      decisions: {},

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
            list: s.list.map((c) => (c.id === id ? { ...c, title: chat.title, state: chat.state, ...waitingOf(chat) } : c)),
          }));
        }
        return { cursor: res.cursor, changed: fresh.length > 0 };
      }, 0),

      send: async (input, context, options = {}) => {
        let id = options.newChat ? null : get().currentId;
        if (!id) {
          const draft = get().draftAgent;
          try {
            const chat = await client.call('POST /kb/chats', {
              body: draft ? { engine: draft.engine, model: draft.model, effort: draft.effort } : {},
            });
            putChat(chat);
            id = chat.id;
            // A chat asked from ⌘K leaves New chat's own agent choice alone.
            set({ currentId: id, draftAgent: options.newChat ? get().draftAgent : null });
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
          // Q-A2: a message of your own closes a waiting question (its part_update confirms it).
          supersedeQuestions(chatId);
          merge(chatId, [res.user], res.assistant);
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
      edit: (chatId, messageId, input) => act(async () => {
        const res = await client.call('POST /kb/chats/{chat_id}/messages/{message_id}/edit', {
          path: { chat_id: chatId, message_id: messageId },
          body: { text: input.text, mentions: input.mentions, quotes: input.quotes, attachments: input.attachments },
        });
        const open = get().chats[chatId];
        if (open?.chat) {
          // What followed the question is gone (the `removed` events say the same to other windows).
          const kept = open.chat.messages.filter((m) => m.seq <= res.user.seq || m.id === res.assistant.id);
          set((s) => ({ chats: { ...s.chats, [chatId]: { ...open, chat: { ...open.chat!, messages: kept } } } }));
        }
        merge(chatId, [res.user], res.assistant);
      }),
      regenerate: (chatId, messageId) => act(async () => {
        const res = await client.call('POST /kb/chats/{chat_id}/messages/{message_id}/regenerate', { path: { chat_id: chatId, message_id: messageId } });
        merge(chatId, [], res.assistant);
      }),
      resume: (chatId, messageId) => act(async () => {
        const res = await client.call('POST /kb/chats/{chat_id}/messages/{message_id}/resume', { path: { chat_id: chatId, message_id: messageId } });
        // The new answer takes the interrupted one's place (2026-10-21; `removed` tells other windows).
        const open = get().chats[chatId];
        if (open?.chat) {
          const kept = open.chat.messages.filter((m) => m.id !== messageId);
          set((s) => ({ chats: { ...s.chats, [chatId]: { ...open, chat: { ...open.chat!, messages: kept } } } }));
        }
        merge(chatId, [], res.assistant);
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
          // The next new chat starts from it too, after a restart (models screen v2).
          return act(async () => {
            await client.call('PUT /kb/chats/last-choice', { body: { engine: choice.engine, model: choice.model, effort: choice.effort } });
          });
        }
        return act(async () => {
          const s = await client.call('PATCH /kb/chats/{chat_id}', {
            path: { chat_id: chatId }, body: { engine: choice.engine, model: choice.model, effort: choice.effort },
          });
          patchSummary(chatId, { engine: s.engine, model: s.model, effort: s.effort });
        });
      },
      setDraftAgent: (choice) => set({ draftAgent: choice }),
      decide: (chatId, partId, body) => act(async () => {
        const part = await decidePermission(client, partId, body);
        set((s) => ({ decisions: { ...s.decisions, [partId]: body.decision } }));
        putPart(chatId, part);
        return part;
      }),
      undo: (chatId, partId) => act(async () => {
        const part = await undoPermission(client, partId);
        putPart(chatId, part);
        return part;
      }),
      answer: (chatId, partId, body) => act(async () => {
        const part = await answerQuestion(client, partId, body);
        putPart(chatId, part);
        return part;
      }),
      applyPart: (chatId, part) => putPart(chatId, part),
      forget: (gone) => set((s) => {
        let changed = false;
        const chats: Record<string, OpenChat> = {};
        for (const [id, open] of Object.entries(s.chats)) {
          const chat = open.chat ? forgetInChat(open.chat, gone) : null;
          if (chat !== open.chat) changed = true;
          chats[id] = chat === open.chat ? open : { ...open, chat };
        }
        return changed ? { chats } : {};
      }),
    };
  });
}
