import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbStudyPart } from '../../api/kb/types.gen';
import { serveFake, type FakeWorld } from '../test/fakeKb';
import { studyWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import type { HttpMethod, StudyWindowTarget } from '../../api/bridge';

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

  it('moves beside the chat and back: one block in one place, the thread keeps a placeholder, the agent is told what is open', async () => {
    const { user, fake } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(screen.queryByRole('note', { name: /Agent sees/ })).toBeNull();
    await user.click(within(deck).getByRole('button', { name: 'Open beside the chat' }));
    const panel = await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    expect(within(panel).getByRole('region', { name: 'Flashcards: Lecture 8' })).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'Flashcards: Lecture 8' })).toHaveLength(1);
    const placeholder = screen.getByRole('group', { name: 'Flashcards: Lecture 8' });
    expect(within(placeholder).getByText(/open beside the chat/)).toBeInTheDocument();
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

  it('closing the panel brings the block back into the chat', async () => {
    const { user, fake } = await openChat(/Lecture 8 — cards/);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    await user.click(within(deck).getByRole('button', { name: 'Open beside the chat' }));
    const panel = await screen.findByRole('complementary', { name: 'Flashcards and tests' });
    await user.click(within(panel).getByRole('button', { name: 'Close — back into the chat' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Flashcards and tests' })).toBeNull());
    await waitFor(() => expect(block(fake.world, 'st-deck').place).toBe('chat'));
  });

  it('opens in its own window through main and comes back when the window is closed', async () => {
    let closed: ((t: StudyWindowTarget) => void) | null = null;
    const openStudyWindow = vi.fn(async () => true);
    const closeStudyWindow = vi.fn(async () => true);
    const { user, fake } = await openChat(/Lecture 8 — cards/, {
      bridge: {
        openStudyWindow, closeStudyWindow,
        onStudyWindowClosed: (listener) => { closed = listener; return () => { closed = null; }; },
      },
    });
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    await user.click(within(deck).getByRole('button', { name: 'Open in a separate window' }));
    await waitFor(() => expect(openStudyWindow).toHaveBeenCalledWith({ studyId: 'st-deck', chatId: 'c12' }));
    expect(within(screen.getByRole('group', { name: 'Flashcards: Lecture 8' })).getByText(/open in its own window/)).toBeInTheDocument();
    await waitFor(() => expect(block(fake.world, 'st-deck').place).toBe('window'));
    act(() => closed?.({ studyId: 'st-deck', chatId: 'c12' }));
    expect(await screen.findByRole('region', { name: 'Flashcards: Lecture 8' })).toBeInTheDocument();
    await waitFor(() => expect(block(fake.world, 'st-deck').place).toBe('chat'));
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

// ---- the block's own window -------------------------------------------------------------------------

describe('The block in its own window (W2)', () => {
  it('shows the block and the same chat below it; closes itself when the block goes back', async () => {
    const { StudyWindowApp } = await import('./StudyWindowApp');
    const { createFakeBridge } = await import('../test/fakeBridge');
    const { render } = await import('@testing-library/react');
    const world = studyWorld();
    call(world, 'PATCH', '/kb/study/st-deck', { place: 'window' });
    const fake = createFakeBridge(world);
    const closeStudyWindow = vi.fn(async () => true);
    render(<StudyWindowApp target={{ studyId: 'st-deck', chatId: 'c12' }} bridge={{ ...fake.bridge, closeStudyWindow }} />);
    const deck = await screen.findByRole('region', { name: 'Flashcards: Lecture 8' });
    expect(within(deck).queryByRole('button', { name: 'Open in a separate window' })).toBeNull();
    expect(within(deck).getByRole('button', { name: 'Back into the chat' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chat' })).toHaveTextContent('Make cards from @Lecture 8');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(screen.getByRole('note', { name: /Agent sees: Flashcards, card 1 of 3/ })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(deck).getByRole('button', { name: 'Back into the chat' }));
    await waitFor(() => expect(closeStudyWindow).toHaveBeenCalled());
    expect(block(fake.world, 'st-deck').place).toBe('chat');
  });
});
