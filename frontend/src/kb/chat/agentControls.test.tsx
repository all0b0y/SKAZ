import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbChatEvent } from '../../api/kb/types.gen';
import { serveFake, type FakeWorld } from '../test/fakeKb';
import { agentControlsWorld, chatWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import { openTarget } from '../state/document';
import { applyEvents } from '../state/chats';
import type { AnyMessagePart, KbChatEventP, KbChatSummaryP, KbPermissionPart } from '../api/permissions';
import { permissionPart } from '../test/fixtures';

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
    expect(within(card).getByText('No other page links here. Sources stay.')).toBeInTheDocument();
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

describe('Review beside the chat (book icon)', () => {
  it('opens the same request in the right panel with every change; the decision bar at its bottom decides for the card too', async () => {
    const { user, fake } = await openChat(/Entropy — edit/);
    const card = await within(centre()).findByRole('region', { name: 'Codex wants to edit Entropy' });
    await user.click(within(card).getByRole('button', { name: 'Review beside the chat' }));
    const panel = screen.getByRole('complementary', { name: 'Review' });
    expect(within(panel).getByRole('heading', { name: 'Entropy' })).toBeInTheDocument();
    expect(within(panel).getByText('Codex wants to edit · 3 changes')).toBeInTheDocument();
    expect(within(panel).getByText(/added/)).toBeInTheDocument();
    expect(within(within(panel).getByRole('list', { name: 'Changes' })).getAllByRole('listitem')).toHaveLength(3);
    expect(within(panel).queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
    // Deny's reason works here as in the card.
    await user.click(within(panel).getByRole('button', { name: 'Deny' }));
    expect(within(panel).getByRole('textbox', { name: 'Reason for Codex (optional)' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await user.click(within(panel).getByRole('button', { name: 'Allow in this chat' }));
    expect(decides(fake)).toEqual([['/kb/permissions/perm-edit/decide', { decision: 'allow_chat' }]]);
    expect(await within(panel).findByRole('group', { name: 'Allowed in this chat: Edited Entropy' })).toBeInTheDocument();
    expect(within(centre()).getByRole('group', { name: 'Allowed in this chat: Edited Entropy' })).toBeInTheDocument();
  });
});

describe('«Waiting for you»: chat list and the Chats rail icon (nothing pops up)', () => {
  it('marks the waiting chats in the side list and in All chats, in words; a dot on Chats', async () => {
    const user = userEvent.setup();
    renderKb({ world: agentControlsWorld() });
    const row = (name: RegExp) => within(side()).findByRole('button', { name });
    expect(await row(/Entropy — edit/)).toHaveTextContent('Waiting for you');
    expect(await row(/Review lecture 8/)).toHaveTextContent('Waiting for you');
    expect(await row(/Wiki tidy-up/)).not.toHaveTextContent('Waiting for you');
    // «Waiting for you» says more than «answering»: the still ring gives way to it.
    expect(within(await row(/Entropy — edit/)).queryByRole('img', { name: 'answering' })).not.toBeInTheDocument();
    const chatsIcon = screen.getByRole('button', { name: 'Chats, waiting for you' });
    expect(within(chatsIcon).getByTestId('chats-waiting-dot')).toBeInTheDocument();

    await user.click(within(side()).getByRole('button', { name: /All chats/ }));
    const all = screen.getByRole('region', { name: 'All chats' });
    const allRow = (await within(all).findByRole('button', { name: /^Entropy — edit/ })).closest('li')!;
    expect(allRow).toHaveTextContent('Waiting for you');
  });

  it('answering in the open chat clears its mark; the dot stays only for other waiting chats', async () => {
    const { user } = await openChat(/Remove Spike/);
    const card = await within(centre()).findByRole('region', { name: 'Codex wants to delete Spike' });
    await user.click(within(card).getByRole('button', { name: 'Delete page' }));
    await within(centre()).findByRole('group', { name: 'Allowed: Deleted Spike' });
    expect(within(side()).getByRole('button', { name: /Remove Spike/ })).not.toHaveTextContent('Waiting for you');
    expect(screen.getByRole('button', { name: 'Chats, waiting for you' })).toBeInTheDocument();
  });

  it('the open chat alone waiting: no dot (you are looking at it)', async () => {
    const world = agentControlsWorld();
    world.chats = world.chats.filter((c) => !['c9', 'c11'].includes(c.id));
    const user = userEvent.setup();
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Entropy — edit/ }));
    await within(centre()).findByRole('region', { name: 'Codex wants to edit Entropy' });
    expect(screen.getByRole('button', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.queryByTestId('chats-waiting-dot')).not.toBeInTheDocument();
  });

  it('comes live with the chat list events', async () => {
    const { fake } = renderKb({ world: chatWorld() });
    const row = await within(side()).findByRole('button', { name: /Compare regularisation/ });
    expect(row).not.toHaveTextContent('Waiting for you');
    const c3 = fake.world.chats.find((c) => c.id === 'c3')!;
    const { messages: _m, cursor: _c, ...summary } = c3;
    void _m; void _c;
    fake.world.listCursor += 1;
    fake.world.listChanges.push({ seq: fake.world.listCursor, chat: { ...summary, waiting_for_user: true } as KbChatSummaryP });
    await waitFor(() => expect(within(side()).getByRole('button', { name: /Compare regularisation/ })).toHaveTextContent('Waiting for you'), { timeout: 6000 });
    expect(screen.getByRole('button', { name: 'Chats, waiting for you' })).toBeInTheDocument();
  }, 10_000);
});

// ---- The agent question (Q-A2, Q-A3: view 1 «Rows with descriptions») -------------------------

const Q = 'Codex asks: Where shall we start reviewing “Lecture 8”?';
const ASKED = 'Codex asked: Where shall we start reviewing “Lecture 8”?';

describe('Agent question in the chat', () => {
  it('rows 1–4 with descriptions, the recommended one first and marked; a click answers by the option’s own index', async () => {
    const world = agentControlsWorld();
    const q = world.chats.find((c) => c.id === 'c9')!.messages[1]!.parts[0] as unknown as { options: Array<{ recommended: boolean }> };
    q.options[0]!.recommended = false;
    q.options[2]!.recommended = true; // «Quick 10» is the agent's recommendation here
    const user = userEvent.setup();
    const { fake } = renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Review lecture 8/ }));
    const block = await within(centre()).findByRole('region', { name: Q });
    expect(block).toHaveTextContent('Codex asks · answer now or later — you can just type');
    const rows = within(within(block).getByRole('list', { name: 'Options' })).getAllByRole('button');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Quick 10, recommended', 'Hard cards first', 'Everything due today', 'All 12 cards']);
    expect(rows[0]).toHaveAccessibleDescription('The 10 closest to being forgotten');
    expect(rows.map((r) => r.getAttribute('aria-keyshortcuts'))).toEqual(['1', '2', '3', '4']);
    expect(within(block).getByRole('textbox', { name: 'Other answer' })).toHaveAttribute('placeholder', 'Other answer…');
    await user.click(rows[0]!);
    expect(decides(fake)).toEqual([['/kb/questions/q1/answer', { option_index: 2 }]]);
    const done = await within(centre()).findByRole('group', { name: ASKED });
    expect(done).toHaveTextContent('You chose Quick 10');
  });

  it('typing in «Other answer…» is not a pick (digits included); Enter sends the text', async () => {
    const { user, fake } = await openChat(/Review lecture 8/);
    const block = await within(centre()).findByRole('region', { name: Q });
    const other = within(block).getByRole('textbox', { name: 'Other answer' });
    await user.type(other, 'Start with 3 formulas{Enter}');
    expect(decides(fake)).toEqual([['/kb/questions/q1/answer', { text: 'Start with 3 formulas' }]]);
    expect(await within(centre()).findByRole('group', { name: ASKED })).toHaveTextContent('You answered Start with 3 formulas');
  });

  it('with the block focused, a digit picks that row', async () => {
    const { user, fake } = await openChat(/Review lecture 8/);
    const block = await within(centre()).findByRole('region', { name: Q });
    block.focus();
    await user.keyboard('2');
    expect(decides(fake)).toEqual([['/kb/questions/q1/answer', { option_index: 1 }]]);
    expect(await within(centre()).findByRole('group', { name: ASKED })).toHaveTextContent('You chose Everything due today');
  });

  it('the composer stays free: writing your own message closes the question; «Pick an option» still answers later', async () => {
    const { user, fake } = await openChat(/Review lecture 8/);
    await within(centre()).findByRole('region', { name: Q });
    const input = screen.getByTestId('message-input');
    expect(input).toHaveAttribute('aria-placeholder', 'Pick an option above, or just type…');
    await user.click(input);
    await user.keyboard('which are my worst?');
    expect(within(centre()).getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-disabled');
    await user.keyboard('{Enter}');
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/chats/c9/messages')).toBe(true);
    const wrote = await within(centre()).findByRole('group', { name: ASKED });
    expect(wrote).toHaveTextContent('You wrote your own message');
    await user.click(within(wrote).getByRole('button', { name: 'Pick an option' }));
    const block = within(centre()).getByRole('region', { name: /^Codex asked: / });
    await user.click(within(block).getByRole('button', { name: 'Hard cards first, recommended' }));
    expect(decides(fake)).toEqual([['/kb/questions/q1/answer', { option_index: 0 }]]);
    expect(await within(centre()).findByRole('group', { name: ASKED })).toHaveTextContent('You chose Hard cards first');
  });

  it('a waiting permission lets you type but says the request waits; a cancelled question is one quiet line', async () => {
    const world = agentControlsWorld();
    const q = world.chats.find((c) => c.id === 'c9')!.messages[1]!.parts[0] as unknown as { status: string };
    q.status = 'cancelled';
    const user = userEvent.setup();
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Entropy — edit/ }));
    await within(centre()).findByRole('region', { name: 'Codex wants to edit Entropy' });
    expect(screen.getByTestId('message-input')).toHaveAttribute('aria-placeholder', 'You can keep typing — the request waits');
    await user.click(within(side()).getByRole('button', { name: /Review lecture 8/ }));
    expect(await within(centre()).findByRole('group', { name: ASKED })).toHaveTextContent('Cancelled');
  });
});

describe('Permission card uses what the backend tells beyond the first contract (merge of P)', () => {
  it('shows the page path, the new title, real link counts, and no Undo when the change can no longer be undone', async () => {
    const user = userEvent.setup();
    const w = agentControlsWorld();
    const parts = (id: string) => w.chats.find((c) => c.id === id)!.messages[1]!.parts as AnyMessagePart[];
    parts('c8')[1] = permissionPart('perm-ren', { kind: 'rename', title: 'Spike', page_id: 'p-spike', path: 'Wiki/Concepts/Spike.md', new_title: 'Action potential', linking_pages: 3 }) as never;
    Object.assign(parts('c11')[0]!, { linking_pages: 2, links_unlinked: 5 });
    parts('c10')[0] = permissionPart('perm-auto', { status: 'allowed', auto: true, undoable: false, title: 'Cross-entropy', page_id: 'p-xent' }) as never;
    parts('c10')[1] = permissionPart('perm-auto2', { status: 'allowed', auto: true, undoable: true, title: 'Boltzmann', page_id: 'p-boltz' }) as never;
    renderKb({ world: w });
    await user.click(await within(side()).findByRole('button', { name: /Entropy — edit/ }));
    const card = await within(centre()).findByRole('region', { name: /Codex wants to rename/ });
    expect(within(card).getByText('Wiki/Concepts/Spike.md')).toBeInTheDocument();
    expect(within(card).getByText(/Action potential/)).toBeInTheDocument();
    expect(within(card).getByText('Links on 3 pages follow the new name.')).toBeInTheDocument();
    await user.click(within(side()).getByRole('button', { name: /Remove Spike/ }));
    const del = await within(centre()).findByRole('region', { name: /Codex wants to delete/ });
    expect(within(del).getByText('5 links on 2 pages are removed; the words stay. Sources stay.')).toBeInTheDocument();
    await user.click(within(side()).getByRole('button', { name: /Wiki tidy-up/ }));
    await within(centre()).findByText(/Boltzmann/);
    expect(within(centre()).getAllByRole('button', { name: /Undo/ })).toHaveLength(1);
  });
});
