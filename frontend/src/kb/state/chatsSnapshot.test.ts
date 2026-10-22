// C-19: the answer an action returns (send, edit, regenerate, resume) is the new answer as it was
// created; the long poll may already have shown more of it. That newer text stays.
import { describe, expect, it, vi } from 'vitest';
import type { KbChat, KbChatEvent, KbMessage } from '../../api/kb/types.gen';
import type { KbClient } from '../api/client';
import { createChatsStore } from './chats';

interface Pending { route: string; resolve: (value: unknown) => void }

function deferredClient() {
  const pending: Pending[] = [];
  const call = vi.fn((route: string) => new Promise((resolve) => { pending.push({ route, resolve }); }));
  const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
  const answer = async (route: string, value: unknown) => {
    const index = pending.findIndex((p) => p.route === route);
    expect(index, `an open ${route}`).toBeGreaterThanOrEqual(0);
    pending.splice(index, 1)[0]!.resolve(value);
    await flush();
  };
  return { client: { call } as unknown as KbClient, answer, flush };
}

const message = (id: string, seq: number, role: KbMessage['role'], state: KbMessage['state'], text: string): KbMessage => ({
  id, seq, role, state, created_at: '2026-10-22T10:00:00Z', engine: role === 'assistant' ? 'codex' : null, model: null,
  parts: text ? [{ type: 'text', text }] : [], failure: null, saved_page_id: null, input: null,
} as KbMessage);

const QUESTION = message('m-q', 1, 'user', 'done', 'What is entropy?');
const OLD = message('m-a1', 2, 'assistant', 'done', 'An old answer.');
const chat: KbChat = {
  id: 'c1', title: 'Chat', pinned: false, engine: 'codex', model: null, effort: null, created_at: '', updated_at: '',
  last_preview: '', recording_material_id: null, folder_ids: [], state: 'idle', unread: false, messages: [QUESTION, OLD], cursor: 5,
};
const CREATED = message('m-a2', 3, 'assistant', 'streaming', '');
const text = (m: KbMessage | undefined) => (m?.parts ?? []).map((p) => ('text' in p ? p.text : '')).join('');

async function opened() {
  const fake = deferredClient();
  const store = createChatsStore(fake.client);
  const loading = store.getState().load('c1');
  await fake.answer('GET /kb/chats/{chat_id}', chat);
  await loading;
  const stop = store.getState().follow('c1');
  await fake.flush();
  /** The poll brings the new answer and its first words. */
  const streamed = async (events: KbChatEvent[]) => fake.answer('GET /kb/chats/{chat_id}/events', { events, cursor: 7 });
  const news: KbChatEvent[] = [
    { seq: 6, type: 'message', message_id: 'm-a2', message: CREATED },
    { seq: 7, type: 'delta', message_id: 'm-a2', text: 'Entropy grows' },
  ];
  const messages = () => store.getState().chats.c1!.chat!.messages;
  return { fake, store, stop, streamed, news, messages };
}

describe('A returned answer never takes back what the poll already showed', () => {
  it('Regenerate', async () => {
    const { fake, store, stop, streamed, news, messages } = await opened();
    const asking = store.getState().regenerate('c1', 'm-a1');
    await streamed(news);
    await fake.answer('POST /kb/chats/{chat_id}/messages/{message_id}/regenerate', { user: QUESTION, assistant: CREATED });
    await asking;
    expect(text(messages().find((m) => m.id === 'm-a2'))).toBe('Entropy grows');
    stop();
  });

  it('Edit: the question changes, the new answer keeps its streamed words', async () => {
    const { fake, store, stop, streamed, news, messages } = await opened();
    const edited = message('m-q', 1, 'user', 'done', 'What is entropy, briefly?');
    const editing = store.getState().edit('c1', 'm-q', { text: 'What is entropy, briefly?', mentions: [], quotes: [], attachments: [] } as never);
    await streamed([{ seq: 6, type: 'removed', message_id: 'm-a1' }, ...news]);
    await fake.answer('POST /kb/chats/{chat_id}/messages/{message_id}/edit', { user: edited, assistant: CREATED });
    await editing;
    expect(messages().map((m) => m.id)).toEqual(['m-q', 'm-a2']);
    expect(text(messages()[0])).toBe('What is entropy, briefly?');
    expect(text(messages()[1])).toBe('Entropy grows');
    stop();
  });

  it('without poll news the returned answer is shown', async () => {
    const { fake, store, stop, messages } = await opened();
    const asking = store.getState().regenerate('c1', 'm-a1');
    await fake.answer('POST /kb/chats/{chat_id}/messages/{message_id}/regenerate', { user: QUESTION, assistant: CREATED });
    await asking;
    expect(messages().map((m) => m.id)).toEqual(['m-q', 'm-a1', 'm-a2']);
    expect(messages()[2]!.state).toBe('streaming');
    stop();
  });
});
