import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbStudyPart } from '../../api/kb/types.gen';
import { serveFake, type FakeWorld } from '../test/fakeKb';
import { studyWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import type { BridgeRequest, HttpMethod } from '../../api/bridge';
import { createFakeBridge } from '../test/fakeBridge';

const call = (w: FakeWorld, method: HttpMethod, path: string, body?: unknown) => serveFake(w, { method, path, body });
const block = (w: FakeWorld, id: string) =>
  w.chats.flatMap((c) => c.messages.flatMap((m) => m.parts)).find((p) => p.type === 'study' && p.id === id) as KbStudyPart;

describe('Fake backend: the /kb/study routes of the phase-S contract', () => {
  it('grades move to the next card, marks change groups, and every change is a part_update of the message', () => {
    const w = studyWorld();
    expect(call(w, 'POST', '/kb/study/st-deck/grade', { item_id: 'c-1', grade: 'easy' }))
      .toMatchObject({ ok: true, data: { position: 1, side: 'question', groups: { new: 2, known: 1 } } });
    expect(call(w, 'POST', '/kb/study/st-deck/grade', { item_id: 'nope', grade: 'good' })).toMatchObject({ ok: false, status: 404 });
    call(w, 'POST', '/kb/study/st-deck/mark', { item_ids: ['c-2'], mark: 'hard' });
    expect(block(w, 'st-deck').groups.hard).toBe(1);
    expect(w.chatEvents.c12!.filter((e) => (e.type as string) === 'part_update')).toHaveLength(2);
  });

  it('one block away from the chat at a time (A-4); saving adds the page; a deck page studies in a new chat', () => {
    const w = studyWorld();
    call(w, 'PATCH', '/kb/study/st-deck', { place: 'panel' });
    call(w, 'PATCH', '/kb/study/st-test', { place: 'window' });
    expect([block(w, 'st-deck').place, block(w, 'st-test').place]).toEqual(['chat', 'window']);
    expect(call(w, 'POST', '/kb/study/st-deck/save', { decision: 'allow' })).toMatchObject({ ok: true, data: { save: { status: 'saved' } } });
    expect(call(w, 'POST', '/kb/study/st-deck/save', { decision: 'allow' })).toMatchObject({ ok: false, status: 409 });
    const studied = call(w, 'POST', '/kb/study/decks/p-deck/study', { mode: 'hard' }) as { data: { chat_id: string; study: KbStudyPart } };
    expect(studied.data.study).toMatchObject({ place: 'panel', origin: 'show', mode: 'hard', total: 1 });
    expect(w.chats[0]!.title).toBe('Study · Thermodynamics');
    expect(block(w, 'st-test').place).toBe('chat');
  });
});

// ---- the block in the chat ------------------------------------------------------------------------

const side = () => screen.getByRole('region', { name: 'Chats' });
async function openChat(name: RegExp, options: Parameters<typeof renderKb>[0] = {}) {
  const user = userEvent.setup();
  const view = renderKb({ world: studyWorld(), ...options });
  await user.click(await within(side()).findByRole('button', { name }));
  return { user, ...view };
}
const requests = (fake: { calls: Array<{ method: string; path: string; body?: unknown }> }, prefix = '/kb/study/') =>
  fake.calls.filter((c) => c.path.startsWith(prefix)).map((c) => `${c.method} ${c.path}`);

describe('Flashcards in the chat (variant C)', () => {
  it('flips to the answer from the source with the agent explanation apart, grades with intervals, and moves on', async () => {
    const { user, fake } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(deck).getByText('1 / 3')).toBeInTheDocument();
    expect(within(deck).getByText('How did Boltzmann write entropy?')).toBeInTheDocument();
    expect(within(deck).queryByRole('group', { name: 'How well did you know it?' })).toBeNull();

    await user.click(within(deck).getByRole('button', { name: /Show answer/ }));
    const grades = await within(deck).findByRole('group', { name: 'How well did you know it?' });
    expect(within(deck).getByText('Answer · from source')).toBeInTheDocument();
    expect(within(deck).getByText('S = k·ln W')).toBeInTheDocument();
    expect(within(deck).getByText(/Like counting the ways/)).toBeInTheDocument();
    expect(within(grades).getByRole('button', { name: 'Good, next in 10m' })).toBeInTheDocument();

    await user.click(within(grades).getByRole('button', { name: 'Good, next in 10m' }));
    await waitFor(() => expect(within(deck).getByText('2 / 3')).toBeInTheDocument());
    expect(within(deck).getByText('Why a logarithm?')).toBeInTheDocument();
    expect(requests(fake)).toEqual(['PATCH /kb/study/st-deck', 'POST /kb/study/st-deck/grade']);
    expect(fake.calls.find((c) => c.path.endsWith('/grade'))?.body).toEqual({ item_id: 'c-1', grade: 'good' });
  });

  it('keys work on the focused block: Space flips, 2 grades Hard, ← goes back; "I know this" hides the card', async () => {
    const { user, fake } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    deck.focus();
    await user.keyboard(' ');
    await within(deck).findByRole('group', { name: 'How well did you know it?' });
    await user.keyboard('2');
    await waitFor(() => expect(within(deck).getByText('2 / 3')).toBeInTheDocument());
    expect(fake.calls.find((c) => c.path.endsWith('/grade'))?.body).toEqual({ item_id: 'c-1', grade: 'hard' });
    await user.click(within(deck).getByRole('button', { name: /I know this/ }));
    await waitFor(() => expect(within(deck).getByText('3 / 3')).toBeInTheDocument());
    expect(fake.calls.find((c) => c.path.endsWith('/mark'))?.body).toEqual({ item_ids: ['c-2'], mark: 'hide' });
    deck.focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(within(deck).getByText('2 / 3')).toBeInTheDocument());
  });

  it('Save to wiki: Deny keeps it in the chat and says so; Save to wiki still works later and links the page', async () => {
    const { user } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(deck).getByText('Codex wants to create')).toBeInTheDocument();
    expect(within(deck).getByText('Wiki/Decks/Lecture 8.md')).toBeInTheDocument();
    await user.click(within(deck).getByRole('button', { name: 'Deny' }));
    expect(await within(deck).findByText(/lives only in this chat; grades are not scheduled/)).toBeInTheDocument();
    await user.click(within(deck).getByRole('button', { name: 'Save to wiki' }));
    expect(await within(deck).findByText('Saved to wiki')).toBeInTheDocument();
    expect(within(deck).getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('Rename (U3): a new title without a new agent run; the page path drops characters a file can\'t hold', async () => {
    const { user, fake } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(deck).queryByRole('button', { name: 'Rename' })).toBeNull(); // no pencil: the title itself renames
    await user.click(within(deck).getByRole('button', { name: 'Rename: Lecture 8' }));
    const field = within(deck).getByRole('textbox', { name: 'Deck name' });
    await user.clear(field);
    await user.type(field, 'Lecture 8: entropy{Enter}');
    const renamed = await screen.findByRole('region', { name: 'Flashcards: Lecture 8: entropy' });
    expect(within(renamed).getByText('Wiki/Decks/Lecture 8 entropy.md')).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.path === '/kb/study/st-deck/rename')).toHaveLength(1);
    expect(fake.calls.some((c) => c.path.endsWith('/messages'))).toBe(false);
    await user.click(within(renamed).getByRole('button', { name: 'Rename: Lecture 8: entropy' }));
    await user.keyboard('{Escape}');
    expect(within(renamed).queryByRole('textbox', { name: 'Deck name' })).toBeNull();
    expect(within(renamed).getByRole('button', { name: 'Rename: Lecture 8: entropy' })).toHaveFocus();
  });

  it('the title opens rename from the keyboard (Enter, F2); Esc cancels; Space on the title or in the field never flips the card', async () => {
    const { user, fake } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    const title = within(deck).getByRole('button', { name: 'Rename: Lecture 8' });
    expect(title).toHaveClass('kb-st-title__btn');
    expect(title).toHaveTextContent(/^Lecture 8$/); // only the name, not «Flashcards ·»
    expect(within(deck).getByText('Flashcards ·')).toBeInTheDocument();
    const before = fake.calls.length;

    title.focus();
    await user.keyboard('{Enter}');
    let field = within(deck).getByRole('textbox', { name: 'Deck name' });
    expect(field).toHaveFocus();
    await user.keyboard(' x');
    expect(field).toHaveValue('Lecture 8 x');
    expect(within(deck).queryByRole('group', { name: 'How well did you know it?' })).toBeNull(); // not flipped
    await user.keyboard('{Escape}');
    expect(within(deck).queryByRole('textbox', { name: 'Deck name' })).toBeNull();
    const back = within(deck).getByRole('button', { name: 'Rename: Lecture 8' });
    expect(back).toHaveFocus();

    await user.keyboard(' ');
    field = await within(deck).findByRole('textbox', { name: 'Deck name' }); // Space activates the title: rename, no flip
    expect(within(deck).queryByRole('group', { name: 'How well did you know it?' })).toBeNull();
    await user.keyboard('{Escape}');
    within(deck).getByRole('button', { name: 'Rename: Lecture 8' }).focus();
    await user.keyboard('{F2}');
    expect(within(deck).getByRole('textbox', { name: 'Deck name' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(fake.calls.slice(before).filter((c) => c.path.startsWith('/kb/study/'))).toEqual([]); // nothing renamed, nothing flipped
  });

  it('a block the agent didn\'t make (Study from a deck page) has a plain title: no rename', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: studyWorld() });
    await screen.findByRole('region', { name: 'Chats' });
    act(() => services.ui.getState().openDocument({ type: 'page', id: 'p-deck' }));
    await user.click(await screen.findByRole('button', { name: 'Hard first' }));
    const panel = await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    const deck = within(panel).getByRole('region', { name: 'Flashcards: Thermodynamics' });
    expect(within(deck).getByText('Thermodynamics')).toHaveClass('kb-st-title__text');
    expect(within(deck).queryByRole('button', { name: /^Rename/ })).toBeNull();
  });

  it('U2: a deck starts open, folds to its title line without losing its place, and stays folded after a restart', async () => {
    const { user, fake, unmount } = await openChat(/Lecture 8 — cards/);
    let deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    const fold = within(deck).getByRole('button', { name: 'Collapse' });
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    const before = fake.calls.length;
    // The fold chevron comes first, before the icon and the title (chat only).
    expect(deck.querySelector('.kb-st-head')!.firstElementChild).toBe(fold);
    await user.click(fold);
    expect(within(deck).queryByRole('progressbar')).toBeNull();
    expect(within(deck).getByText('Flashcards ·')).toBeInTheDocument();
    expect(within(deck).getByRole('button', { name: 'Rename: Lecture 8' })).toBeInTheDocument();
    expect(within(deck).getByRole('button', { name: 'Expand' })).toHaveAttribute('aria-expanded', 'false');
    expect(fake.calls.slice(before)).toEqual([]); // no agent, no request
    unmount();

    renderKb({ world: studyWorld(), keepStorage: true });
    await userEvent.setup().click(await within(side()).findByRole('button', { name: /Lecture 8 — cards/ }));
    deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(deck).queryByRole('progressbar')).toBeNull();
    await user.click(within(deck).getByRole('button', { name: 'Expand' }));
    expect(within(deck).getByText('1 / 3')).toBeInTheDocument();
  });

  it('U2 (decision 5): a folded deck opened beside the chat is open there; the thread keeps a folded "Open beside the chat" row; back in the chat the fold is kept', async () => {
    const { user, fake } = await openChat(/Lecture 8 — cards/);
    let deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    await user.click(within(deck).getByRole('button', { name: 'Collapse' }));
    const before = fake.calls.length;
    await user.click(within(deck).getByRole('button', { name: 'Bigger — beside the chat' }));

    const panel = await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    const beside = within(panel).getByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(beside).getByRole('progressbar', { name: 'Progress' })).toBeInTheDocument();
    expect(within(beside).getByText('1 / 3')).toBeInTheDocument();
    expect(within(beside).queryByRole('button', { name: /^(Collapse|Expand)$/ })).toBeNull();
    await waitFor(() => expect(beside).toHaveFocus()); // keyboard focus follows the block

    const row = screen.getByRole('group', { name: 'Flashcards: Lecture 8' });
    expect(within(row).getByText('Flashcards · Lecture 8')).toBeInTheDocument();
    expect(within(row).getByText('Open beside the chat')).toBeInTheDocument();
    expect(row.querySelector('.kb-st-ph__where [data-icon="panelRight"]')).not.toBeNull();
    expect(within(row).queryByRole('progressbar')).toBeNull();
    expect(fake.calls.slice(before).map((c) => `${c.method} ${c.path}`).filter((c) => c.startsWith('POST') || c.includes('/kb/study/')))
      .toEqual(['PATCH /kb/study/st-deck']); // folding and moving call no agent

    await user.click(within(row).getByRole('button', { name: 'Bring back' }));
    deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(deck).getByRole('button', { name: 'Expand' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(deck).queryByRole('progressbar')).toBeNull();
    await waitFor(() => expect(deck).toHaveFocus());
  });

  it('moves beside the chat and back: one block in one place, the thread keeps a placeholder, the agent is told what is open', async () => {
    const { user, fake } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(screen.queryByRole('note', { name: /Agent sees/ })).toBeNull();
    await user.click(within(deck).getByRole('button', { name: 'Bigger — beside the chat' }));
    const panel = await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    expect(within(panel).getByRole('region', { name: 'Flashcards: Lecture 8' })).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'Flashcards: Lecture 8' })).toHaveLength(1);
    const placeholder = screen.getByRole('group', { name: 'Flashcards: Lecture 8' });
    expect(within(placeholder).getByText('Open beside the chat')).toBeInTheDocument();
    expect(screen.getByRole('note', { name: 'Agent sees: Flashcards, card 1 of 3 · question side, beside the chat' })).toBeInTheDocument();

    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.keyboard('explain this card{Enter}');
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/kb/chats/c12/messages')).toBe(true));
    const sent = fake.calls.find((c) => c.path === '/kb/chats/c12/messages')!.body as { context: Record<string, unknown> };
    expect(sent.context.open_study_id).toBe('st-deck');

    await user.click(within(placeholder).getByRole('button', { name: 'Bring back' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Flashcards and tests' })).toBeNull());
    expect(await screen.findByRole('region', { name: 'Flashcards: Lecture 8' })).toBeInTheDocument();
    expect(fake.world.chats.find((c) => c.id === 'c12')!.messages[1]!.parts.find((p) => p.type === 'study')).toMatchObject({ place: 'chat' });
  });

  it('one size button, two states: ⤢ in the chat, ⤡ beside it; the panel has no header or × of its own', async () => {
    const { user, fake } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    const route = deck.querySelector('.kb-st-route')!;
    expect(within(route as HTMLElement).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Bigger — beside the chat']);
    expect(route.querySelector('[data-icon="grow"]')).not.toBeNull();
    await user.click(within(deck).getByRole('button', { name: 'Bigger — beside the chat' }));

    const panel = await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    const beside = within(panel).getByRole('region', { name: 'Flashcards: Lecture 8' });
    const sized = beside.querySelector('.kb-st-route')!;
    expect(within(sized as HTMLElement).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Smaller — back into the chat']);
    expect(sized.querySelector('[data-icon="shrink"]')).not.toBeNull();
    expect(within(beside).getByText('Flashcards ·')).toBeInTheDocument(); // the full «Kind · Title» beside the chat too
    expect(within(beside).getByRole('button', { name: 'Rename: Lecture 8' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Close/ })).toBeNull();
    expect(panel.querySelector('.kb-head')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Bigger — beside the chat' })).toBeNull();

    await user.click(within(beside).getByRole('button', { name: 'Smaller — back into the chat' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Flashcards and tests' })).toBeNull());
    const back = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(back).getByRole('button', { name: 'Bigger — beside the chat' })).toBeInTheDocument();
    await waitFor(() => expect(back).toHaveFocus());
    await waitFor(() => expect(block(fake.world, 'st-deck').place).toBe('chat'));
  });

  it('closing the panel another way (Esc) still brings the block back into the chat', async () => {
    const { user, fake, services } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    await user.click(within(deck).getByRole('button', { name: 'Bigger — beside the chat' }));
    await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    await waitFor(() => expect(block(fake.world, 'st-deck').place).toBe('panel'));
    act(() => services.ui.getState().closeDoc());
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Flashcards and tests' })).toBeNull());
    await waitFor(() => expect(block(fake.world, 'st-deck').place).toBe('chat'));
  });

  it('no separate window anywhere, even on a host that still offers one', async () => {
    const openStudyWindow = vi.fn(async () => true);
    const { user } = await openChat(/Lecture 8 — cards/, {
      // An old preload's members: nothing in the interface reads them any more.
      bridge: { openStudyWindow, closeStudyWindow: vi.fn(async () => true), onStudyWindowClosed: () => () => undefined } as never,
    });
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(deck).queryByRole('button', { name: /window/i })).toBeNull();
    await user.click(within(deck).getByRole('button', { name: 'Bigger — beside the chat' }));
    const panel = await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    expect(within(panel).queryByRole('button', { name: /window/i })).toBeNull();
    expect(screen.queryByText(/window/i)).toBeNull();
    expect(openStudyWindow).not.toHaveBeenCalled();
  });

  it('the panel of a block that is gone keeps a way out: Close', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: studyWorld() });
    await screen.findByRole('region', { name: 'Chats' });
    act(() => services.ui.getState().openStudy('c12', 'st-gone'));
    const panel = await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    expect(within(panel).getByText('This block isn’t here any more')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Flashcards and tests' })).toBeNull());
  });
});

describe('A block stored in the retired own window (place «window»)', () => {
  it('shows in the chat, not as a placeholder, and the backend is told once that it is in the chat', async () => {
    const world = studyWorld();
    call(world, 'PATCH', '/kb/study/st-deck', { place: 'window' });
    const { fake } = await openChat(/Lecture 8 — cards/, { world });
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(deck).getByRole('button', { name: 'Bigger — beside the chat' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Flashcards: Lecture 8' })).toBeNull();
    await waitFor(() => expect(block(fake.world, 'st-deck').place).toBe('chat'));
    const moves = fake.calls.filter((c) => c.method === 'PATCH' && c.path === '/kb/study/st-deck');
    expect(moves.map((c) => c.body)).toEqual([{ place: 'chat' }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls.filter((c) => c.method === 'PATCH' && c.path === '/kb/study/st-deck')).toHaveLength(1);
    expect(screen.queryByRole('note', { name: /window/ })).toBeNull();
  });

  it('a failed move is ignored: the block stays in the chat, no error, no retry', async () => {
    const world = studyWorld();
    call(world, 'PATCH', '/kb/study/st-deck', { place: 'window' });
    const inner = createFakeBridge(world);
    const request = vi.fn((req: BridgeRequest) => (req.method === 'PATCH' && req.path === '/kb/study/st-deck'
      ? Promise.resolve({ ok: false as const, status: 503, detail: 'Backend is busy' })
      : inner.bridge.request(req)));
    await openChat(/Lecture 8 — cards/, { world, bridge: { request: request as never } });
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    await waitFor(() => expect(request.mock.calls.filter(([r]) => r.method === 'PATCH' && r.path === '/kb/study/st-deck')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('region', { name: 'Flashcards: Lecture 8' })).toBe(deck);
    expect(within(deck).queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Backend is busy')).toBeNull();
    expect(request.mock.calls.filter(([r]) => r.method === 'PATCH' && r.path === '/kb/study/st-deck')).toHaveLength(1);
  });
});

describe('A test in the chat', () => {
  it('choice and short answers are checked by SKAZ; the open one by the agent, as its opinion; result and retake mistakes', { timeout: 15_000 }, async () => {
    const { user, fake } = await openChat(/Lecture 8 — test/);
    const test = await screen.findByRole('region', { name: 'Test: Lecture 8 check' });
    expect(within(test).getByText('· Choose one')).toBeInTheDocument();
    expect(within(test).queryByText(/made up by/)).toBeNull(); // not before checking

    await user.click(within(test).getByRole('radio', { name: 'S = k·W²' }));
    await user.click(within(test).getByRole('button', { name: 'Check' }));
    expect(await within(test).findByText('Not quite.')).toBeInTheDocument();
    expect(within(test).getByRole('radio', { name: /S = k·ln W.*Correct · from source/ })).toBeInTheDocument();
    expect(within(test).getByRole('radio', { name: /S = W \/ k.*made up by Codex/ })).toBeInTheDocument();

    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.type(await within(test).findByRole('textbox', { name: 'Your answer' }), 'w');
    await user.click(within(test).getByRole('button', { name: 'Check' }));
    expect(await within(test).findByText('Correct.')).toBeInTheDocument();

    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.type(await within(test).findByRole('textbox', { name: 'Your answer' }), 'Because joined systems add up.');
    await user.click(within(test).getByRole('button', { name: 'Ask the agent to check' }));
    // The verdict comes as an update of the block (the chat's event feed), not in the answer to the click.
    expect(await within(test).findByText('Codex’s opinion · not a fact', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(within(test).getByText('Partly right.')).toBeInTheDocument();
    expect(within(test).getByText(/Think of what happens/)).toBeInTheDocument();
    expect(requests(fake).filter((r) => r.includes('check-open'))).toHaveLength(1);

    await user.click(within(test).getByRole('button', { name: 'See result' }));
    expect(await within(test).findByText('1.5 of 3')).toBeInTheDocument();
    expect(within(test).getByText(/One open answer is half-right/)).toBeInTheDocument();
    await user.click(within(test).getByRole('button', { name: 'Retake mistakes · 2' }));
    await waitFor(() => expect(within(test).getByText('1 / 2')).toBeInTheDocument());
    expect(fake.calls.find((c) => c.path.endsWith('/retake'))?.body).toEqual({ mistakes_only: true });
  });

  it('options carry A/B/C keys; with the block focused A/B/C or 1/2/3 pick one (radio semantics kept); typing in a field doesn\'t', async () => {
    const { user, fake } = await openChat(/Lecture 8 — test/);
    const test = await screen.findByRole('region', { name: 'Test: Lecture 8 check' });
    const options = within(test).getAllByRole('radio');
    expect(options.map((o) => o.querySelector('.kb-st-key')?.textContent)).toEqual(['A', 'B', 'C']);
    expect(options.map((o) => o.getAttribute('aria-keyshortcuts'))).toEqual(['A 1', 'B 2', 'C 3']);
    expect(options[0]).toHaveAccessibleName('S = k·W²'); // the badge is not read as part of the option
    expect(test.querySelector('.kb-st-rad, .kb-st-box')).toBeNull();

    test.focus();
    await user.keyboard('b');
    expect(within(test).getByRole('radio', { name: 'S = k·ln W' })).toHaveAttribute('aria-checked', 'true');
    expect(within(test).getByRole('radio', { name: 'S = k·W²' })).toHaveAttribute('aria-checked', 'false');
    await user.keyboard('1');
    expect(within(test).getByRole('radio', { name: 'S = k·W²' })).toHaveAttribute('aria-checked', 'true');
    expect(within(test).getByRole('radio', { name: 'S = k·ln W' })).toHaveAttribute('aria-checked', 'false');
    await user.keyboard('d'); // no fourth option: nothing changes
    expect(within(test).getByRole('radio', { name: 'S = k·W²' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.keyboard('c');
    expect(within(test).getByRole('radio', { name: 'S = W / k' })).toHaveAttribute('aria-checked', 'false');
    expect(fake.calls.filter((c) => c.path.endsWith('/answer'))).toEqual([]); // picking sends nothing; Check does

    await user.click(within(test).getByRole('button', { name: 'Check' }));
    expect(await within(test).findByText('Not quite.')).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path.endsWith('/answer'))?.body).toEqual({ item_id: 'q-1', choices: ['w0'] });
    test.focus();
    await user.keyboard('b'); // checked: keys pick nothing any more
    expect(within(test).getByRole('radio', { name: /S = k·ln W/ })).toHaveAttribute('aria-checked', 'false');
    expect(within(test).getByRole('radio', { name: /S = k·ln W/ }).closest('.kb-st-opt')).toHaveClass('is-ok');
  });

  it('the chat stays free while the agent checks an open answer', async () => {
    const world = studyWorld();
    world.judge = { verdict: 'right', missing: '', comment: '', hold: true };
    const { user } = await openChat(/Lecture 8 — test/, { world });
    const test = await screen.findByRole('region', { name: 'Test: Lecture 8 check' });
    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.type(await within(test).findByRole('textbox', { name: 'Your answer' }), 'Logs add.');
    await user.click(within(test).getByRole('button', { name: 'Ask the agent to check' }));
    expect(await within(test).findByText('Codex is checking your answer…')).toBeInTheDocument();
    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.keyboard('while you check: why ln?');
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-disabled');
  });
});

// ---- the deck page, @ decks, "Make cards from these", the daily limit ----------------------------

describe('The deck page (S12)', () => {
  it('shows groups and cards; marks go to FSRS; Study opens the block beside the chat in a new chat', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ world: studyWorld() });
    await screen.findByRole('region', { name: 'Chats' });
    act(() => services.ui.getState().openDocument({ type: 'page', id: 'p-deck' }));
    const groups = await screen.findByRole('list', { name: 'Cards by group' });
    expect(within(groups).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['New1', 'Learning1', 'Known1', 'Hard1']);
    const cards = screen.getByRole('grid', { name: 'Cards' });
    const row = within(cards).getByRole('row', { name: /What is a microstate\?/ });
    await user.click(within(row).getByRole('button', { name: 'Known' }));
    await waitFor(() => expect(within(groups).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['New0', 'Learning1', 'Known2', 'Hard1']));
    expect(fake.calls.find((c) => c.path === '/kb/study/decks/p-deck/marks')?.body).toEqual({ item_ids: ['d-4'], mark: 'known' });

    await user.click(screen.getByRole('button', { name: 'Hard first' }));
    const panel = await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    const deck = within(panel).getByRole('region', { name: 'Flashcards: Thermodynamics' });
    expect(within(deck).getByText('1 / 1')).toBeInTheDocument();
    expect(within(deck).getByText(/Practice: doesn’t change your schedule/)).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path === '/kb/study/decks/p-deck/study')?.body).toEqual({ mode: 'hard', card_ids: null, chat_id: null });
    expect(await screen.findByRole('heading', { name: 'Study · Thermodynamics' })).toBeInTheDocument();
  });

  it('decks come first in the @ list, as their own group', async () => {
    const user = userEvent.setup();
    renderKb({ world: studyWorld() });
    const input = await screen.findByRole('textbox', { name: 'Message' });
    await user.click(input);
    await user.keyboard('@thermo');
    const list = await screen.findByRole('listbox');
    await within(list).findByText('Thermodynamics');
    expect(within(list).getByText('Decks')).toBeInTheDocument();
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('Thermodynamics');
  });

  it('"Make cards from this" puts the request with the page as a token into the message field', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: studyWorld() });
    await screen.findByRole('region', { name: 'Chats' });
    act(() => services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }));
    await user.click(await screen.findByRole('button', { name: 'Page actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Make cards from this' }));
    const input = screen.getByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(input).toHaveTextContent('Make flashcards from Entropy'));
    expect(within(input).getByText('Entropy')).toHaveClass('kb-token--mention');
  });

  it('Settings → Wiki → New cards per day reads and saves the limit', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: studyWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true })); });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(dialog).getByRole('button', { name: /^Wiki/ }));
    const field = await within(dialog).findByRole('spinbutton', { name: 'New cards per day' });
    await waitFor(() => expect(field).toHaveValue(20));
    await user.clear(field);
    await user.type(field, '5{Enter}');
    await waitFor(() => expect(fake.world.studyNewPerDay).toBe(5));
  });
});
