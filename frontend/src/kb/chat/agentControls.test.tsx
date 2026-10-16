import { describe, expect, it } from 'vitest';
import { serveFake, type FakeWorld } from '../test/fakeKb';
import { agentControlsWorld } from '../test/fixtures';
import type { AnyMessagePart, KbChatEventP, KbChatSummaryP } from '../api/permissions';

const post = (w: FakeWorld, path: string, body?: unknown) => serveFake(w, { method: 'POST', path, body });
const partIn = (w: FakeWorld, chatId: string, id: string) =>
  w.chats.find((c) => c.id === chatId)!.messages.flatMap((m) => m.parts as AnyMessagePart[]).find((p) => 'id' in p && p.id === id);
const listed = (w: FakeWorld, chatId: string) =>
  ((serveFake(w, { method: 'GET', path: '/kb/chats' }) as { data: KbChatSummaryP[] }).data).find((c) => c.id === chatId)!;
const events = (w: FakeWorld, chatId: string) => w.chatEvents[chatId] as unknown as KbChatEventP[];

describe('Fake backend: permission and question routes of the phase-P contract', () => {
  it('decide: allow applies once, a second decision is 409; the chat stops waiting; a part_update event carries the whole part', () => {
    const w = agentControlsWorld();
    expect(listed(w, 'c8').waiting_for_user).toBe(true);
    const res = post(w, '/kb/permissions/perm-edit/decide', { decision: 'allow' });
    expect(res).toMatchObject({ ok: true, status: 200, data: { type: 'permission', id: 'perm-edit', status: 'allowed', auto: false } });
    expect(partIn(w, 'c8', 'perm-edit')).toMatchObject({ status: 'allowed' });
    expect(events(w, 'c8').find((e) => e.type === 'part_update')).toMatchObject({ message_id: 'c8-a1', part: { id: 'perm-edit', status: 'allowed' } });
    expect(listed(w, 'c8').waiting_for_user).toBe(false);
    expect(post(w, '/kb/permissions/perm-edit/decide', { decision: 'deny' })).toMatchObject({ ok: false, status: 409 });
  });

  it('deny keeps the reason; delete has no «Allow in this chat»; an unknown id is 404', () => {
    const w = agentControlsWorld();
    expect(post(w, '/kb/permissions/perm-edit/decide', { decision: 'deny', reason: 'Only from the lecture' }))
      .toMatchObject({ ok: true, data: { status: 'denied', reason: 'Only from the lecture' } });
    expect(post(w, '/kb/permissions/perm-del/decide', { decision: 'allow_chat' })).toMatchObject({ ok: false, status: 422 });
    expect(post(w, '/kb/permissions/nope/decide', { decision: 'allow' })).toMatchObject({ ok: false, status: 404 });
  });

  it('undo: an applied change becomes undone; the page changed since → 409 with the reason in words', () => {
    const w = agentControlsWorld();
    expect(post(w, '/kb/permissions/perm-auto/undo')).toMatchObject({ ok: true, data: { id: 'perm-auto', status: 'undone' } });
    expect(post(w, '/kb/permissions/perm-denied/undo')).toMatchObject({ ok: false, status: 409 });
    const w2 = agentControlsWorld();
    w2.undoRefusals = { 'perm-auto': 'The page changed after this edit. Undo it by hand.' };
    expect(post(w2, '/kb/permissions/perm-auto/undo')).toMatchObject({ ok: false, status: 409, detail: 'The page changed after this edit. Undo it by hand.' });
  });

  it('answer: by option index or own text; answered twice is 409; writing a message instead supersedes the question', () => {
    const w = agentControlsWorld();
    expect(post(w, '/kb/questions/q1/answer', { option_index: 2 })).toMatchObject({ ok: true, data: { id: 'q1', status: 'answered', answer: 'Quick 10' } });
    expect(listed(w, 'c9').waiting_for_user).toBe(false);
    expect(post(w, '/kb/questions/q1/answer', { text: 'again' })).toMatchObject({ ok: false, status: 409 });

    const w2 = agentControlsWorld();
    expect(post(w2, '/kb/questions/q1/answer', {})).toMatchObject({ ok: false, status: 422 });
    expect(post(w2, '/kb/chats/c9/messages', { text: 'which are my worst?', mentions: [], quotes: [], attachments: [], context: {} })).toMatchObject({ ok: true, status: 202 });
    expect(partIn(w2, 'c9', 'q1')).toMatchObject({ status: 'superseded' });
    // A late pick still answers; it goes to the agent as a new message.
    expect(post(w2, '/kb/questions/q1/answer', { option_index: 0 })).toMatchObject({ ok: true, data: { status: 'answered', answer: 'Hard cards first' } });
    expect(w2.chats.find((c) => c.id === 'c9')!.messages.some((m) => m.role === 'user' && m.input?.text === 'Answer to the question: Hard cards first')).toBe(true);
  });

  it('a waiting permission still blocks a new message (only a question gives way to typing)', () => {
    const w = agentControlsWorld();
    expect(post(w, '/kb/chats/c8/messages', { text: 'hm', mentions: [], quotes: [], attachments: [], context: {} })).toMatchObject({ ok: false, status: 409 });
  });
});
