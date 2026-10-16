import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbChatEvent } from '../../api/kb/types.gen';
import { serveFake, type FakeWorld } from '../test/fakeKb';
import { agentControlsWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import { openTarget } from '../state/document';
import { applyEvents } from '../state/chats';
import type { AnyMessagePart, KbChatEventP, KbChatSummaryP, KbPermissionPart } from '../api/permissions';

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

// ---- The permission card in the chat (P4 variant A) -------------------------------------------

const side = () => screen.getByRole('region', { name: 'Chats' });
const centre = () => screen.getByRole('region', { name: 'Chat' });
async function openChat(name: RegExp) {
  const user = userEvent.setup();
  const view = renderKb({ world: agentControlsWorld() });
  await user.click(await within(side()).findByRole('button', { name }));
  return { user, ...view };
}
const decides = (fake: { calls: Array<{ method: string; path: string; body?: unknown }> }) =>
  fake.calls.filter((c) => c.method === 'POST' && /^\/kb\/(permissions|questions)\//.test(c.path)).map((c) => [c.path, c.body]);

describe('Permission card in the chat', () => {
  it('says who wants what, sums it up and shows the first changes by block with labels; Show all reveals the rest', async () => {
    await openChat(/Entropy — edit/);
    const card = await within(centre()).findByRole('region', { name: 'Codex wants to edit Entropy' });
    expect(within(card).getByText('Codex wants to edit')).toBeInTheDocument();
    const summary = within(card).getByRole('list', { name: 'Summary' });
    expect(within(summary).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['+2 blocks', '1 changed', 'your notes untouched']);
    const changes = within(card).getByRole('list', { name: 'Changes' });
    // Not by colour alone: each block says Added / Changed / Removed and its label.
    expect(within(changes).getAllByRole('listitem').map((li) => li.querySelector('.kb-perm__lab')?.textContent)).toEqual(['Changed · From sources', 'Added · Agent explanation']);
    expect(within(changes).getByText('A measure of the disorder of a system.').tagName).toBe('DEL');
    await userEvent.click(within(card).getByRole('button', { name: 'Show all 3 changes' }));
    expect(within(changes).getAllByRole('listitem')).toHaveLength(3);
    expect(within(card).getByRole('button', { name: 'Allow in this chat' })).toBeInTheDocument();
  });

  it('Allow sends the decision and the card becomes one line «Allowed» with Open (the page on the right)', async () => {
    const { user, fake, services } = await openChat(/Entropy — edit/);
    const card = await within(centre()).findByRole('region', { name: 'Codex wants to edit Entropy' });
    await user.click(within(card).getByRole('button', { name: 'Allow' }));
    expect(decides(fake)).toEqual([['/kb/permissions/perm-edit/decide', { decision: 'allow' }]]);
    const done = await within(centre()).findByRole('group', { name: 'Allowed: Edited Entropy' });
    await user.click(within(done).getByRole('button', { name: 'Open' }));
    expect(openTarget(services.ui.getState())).toMatchObject({ type: 'page', id: 'p-entropy' });
  });

  it('Deny opens an optional reason: Esc goes back to the buttons, Enter sends it; the line keeps the reason', async () => {
    const { user, fake } = await openChat(/Entropy — edit/);
    const card = await within(centre()).findByRole('region', { name: 'Codex wants to edit Entropy' });
    await user.click(within(card).getByRole('button', { name: 'Deny' }));
    const reason = within(card).getByRole('textbox', { name: 'Reason for Codex (optional)' });
    expect(reason).toHaveFocus();
    expect(reason).toHaveAttribute('placeholder', 'Tell Codex why (optional)');
    await user.keyboard('{Escape}');
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Deny' })).toHaveFocus();
    await user.click(within(card).getByRole('button', { name: 'Deny' }));
    await user.type(within(card).getByRole('textbox', { name: 'Reason for Codex (optional)' }), 'Only from the lecture{Enter}');
    expect(decides(fake)).toEqual([['/kb/permissions/perm-edit/decide', { decision: 'deny', reason: 'Only from the lecture' }]]);
    const done = await within(centre()).findByRole('group', { name: 'Denied: Entropy' });
    expect(done).toHaveTextContent('Your reason was sent to Codex: “Only from the lecture”');
  });

  it('Allow in this chat says so; an already answered request shows the backend’s reason', async () => {
    const { user, fake } = await openChat(/Entropy — edit/);
    fake.world.failures['POST /kb/permissions/perm-edit/decide'] = { status: 409, detail: 'This request was already answered.' };
    const card = await within(centre()).findByRole('region', { name: 'Codex wants to edit Entropy' });
    await user.click(within(card).getByRole('button', { name: 'Allow in this chat' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('This request was already answered.');
    await user.click(within(card).getByRole('button', { name: 'Allow in this chat' }));
    expect(await within(centre()).findByRole('group', { name: 'Allowed in this chat: Edited Entropy' })).toBeInTheDocument();
    expect(decides(fake).at(-1)).toEqual(['/kb/permissions/perm-edit/decide', { decision: 'allow_chat' }]);
  });

  it('decided requests are one line: no question → Undo; denied with the reason; cancelled; Undo refused says why', async () => {
    const { user, fake } = await openChat(/Wiki tidy-up/);
    const auto = await within(centre()).findByRole('group', { name: 'Allowed in this chat · no question: Edited Cross-entropy' });
    expect(within(centre()).getByRole('group', { name: 'Denied: Entropy' })).toHaveTextContent('Only from the lecture, no comparisons');
    expect(within(centre()).getByRole('group', { name: 'Cancelled: Microstate' })).toHaveTextContent('No change was made');
    fake.world.undoRefusals = { 'perm-auto': 'The page changed after this edit. Undo it by hand.' };
    await user.click(within(auto).getByRole('button', { name: 'Undo' }));
    expect(await within(auto).findByRole('alert')).toHaveTextContent('The page changed after this edit. Undo it by hand.');
    fake.world.undoRefusals = {};
    await user.click(within(auto).getByRole('button', { name: 'Undo' }));
    expect(await within(centre()).findByRole('group', { name: 'Undone: Cross-entropy' })).toBeInTheDocument();
    expect(decides(fake).filter(([p]) => p === '/kb/permissions/perm-auto/undo')).toHaveLength(2);
  });

  it('delete: no «Allow in this chat», a red «Delete page», and what disappears', async () => {
    const { user, fake } = await openChat(/Remove Spike/);
    const card = await within(centre()).findByRole('region', { name: 'Codex wants to delete Spike' });
    expect(within(card).queryByRole('button', { name: 'Allow in this chat' })).not.toBeInTheDocument();
    expect(within(card).getByText('Links to this page are removed; the words stay. Sources stay.')).toBeInTheDocument();
    const del = within(card).getByRole('button', { name: 'Delete page' });
    expect(del.className).toMatch(/kb-btn--danger/);
    await user.click(del);
    expect(decides(fake)).toEqual([['/kb/permissions/perm-del/decide', { decision: 'allow' }]]);
    expect(await within(centre()).findByRole('group', { name: 'Allowed: Deleted Spike' })).toBeInTheDocument();
  });
});

describe('Chat events: part_update', () => {
  it('replaces the part with the same id in its message, nothing else', () => {
    const w = agentControlsWorld();
    const chat = structuredClone(w.chats.find((c) => c.id === 'c8')!);
    const before = chat.messages[0];
    const part = { ...(chat.messages[1]!.parts[1] as unknown as KbPermissionPart), status: 'allowed' as const };
    const next = applyEvents(chat, [{ seq: 9, type: 'part_update', message_id: 'c8-a1', part } as unknown as KbChatEvent]);
    expect((next.messages[1]!.parts as AnyMessagePart[]).map((p) => p.type)).toEqual(['text', 'permission']);
    expect(next.messages[1]!.parts[1]).toMatchObject({ id: 'perm-edit', status: 'allowed' });
    expect(next.messages[0]).toBe(before);
    expect(next.cursor).toBe(9);
  });
});
