import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbMessage, KbStudyPart } from '../../api/kb/types.gen';
import { studyWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import { DISCUSS_UNCLEAR_TEXT, lastUnclearAnswer } from './Unclear';
import { ASK_QUESTION_TEXT } from './AskAgent';

// P3-b: «Unclear» on test questions and cards, «Discuss unclear · N», «Clear now» (the user's button).

const side = () => screen.getByRole('region', { name: 'Chats' });
async function openChat(name: RegExp, world = studyWorld()) {
  const user = userEvent.setup();
  const view = renderKb({ world });
  await user.click(await within(side()).findByRole('button', { name }));
  return { user, ...view };
}
const field = () => screen.getByRole('textbox', { name: 'Message' });

describe('P3-b: Unclear', () => {
  it('a question is marked Unclear on the item; the result offers Discuss unclear · 1 into this chat’s field', { timeout: 15_000 }, async () => {
    const { user, fake, services } = await openChat(/Lecture 8 — test/);
    const test = await screen.findByRole('region', { name: 'Test: Lecture 8 check' });
    const mark = within(test).getByRole('button', { name: 'I have a question' });
    expect(mark).toHaveAttribute('aria-pressed', 'false');
    await user.click(mark);
    await waitFor(() => expect(within(test).getByRole('button', { name: 'Unclear' })).toHaveAttribute('aria-pressed', 'true'));
    expect(fake.calls.find((c) => c.path === '/kb/study/st-test/mark')?.body).toEqual({ item_ids: ['q-1'], mark: 'unclear' });
    expect(fake.calls.filter((c) => c.path.endsWith('/grade'))).toEqual([]); // never FSRS

    const chatId = services.chats.getState().currentId;
    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.click(within(test).getByRole('button', { name: 'See result' }));
    await user.click(await within(test).findByRole('button', { name: 'Discuss unclear · 1' }));
    await waitFor(() => expect(field()).toHaveTextContent(DISCUSS_UNCLEAR_TEXT));
    expect(services.chats.getState().currentId).toBe(chatId);
    expect(fake.calls.filter((c) => c.path.endsWith('/messages'))).toEqual([]); // nothing is sent by itself
  });

  it('a card is marked from its face; the deck page marks a row and discusses in a new chat with the deck as a token', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ world: studyWorld() });
    await screen.findByRole('region', { name: 'Chats' });
    act(() => services.ui.getState().openDocument({ type: 'page', id: 'p-deck' }));
    const cards = await screen.findByRole('grid', { name: 'Cards' });
    const row = within(cards).getByRole('row', { name: /What is a microstate\?/ });
    await user.click(within(row).getByRole('button', { name: 'Unclear' }));
    expect(fake.calls.find((c) => c.path === '/kb/study/decks/p-deck/marks')?.body).toEqual({ item_ids: ['d-4'], mark: 'unclear' });
    await waitFor(() => expect(within(row).getByRole('img', { name: 'Unclear' })).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: 'Discuss unclear · 1' }));
    expect(services.chats.getState().currentId).toBeNull(); // a new chat
    await waitFor(() => expect(field()).toHaveTextContent(DISCUSS_UNCLEAR_TEXT));
    expect(field().querySelector('[data-kind="mention"], .kb-token')).not.toBeNull();
  });

  it('Clear now under the agent’s answer that read the marks clears them — the user’s button, one or all', async () => {
    const world = studyWorld();
    const chat = world.chats.find((c) => c.title === 'Lecture 8 — test')!;
    const testPart = chat.messages.flatMap((m) => m.parts).find((p) => p.type === 'study') as KbStudyPart;
    testPart.questions[0]!.unclear = true;
    testPart.questions[2]!.unclear = true;
    const answer = chat.messages.find((m) => m.role === 'assistant')!;
    chat.messages.push({
      ...structuredClone(answer), id: 'm-unclear', seq: answer.seq + 10,
      parts: [{ type: 'tool', name: 'skaz_study_unclear', label: 'Read what you marked unclear' }, { type: 'text', text: 'Let’s go one by one.' }],
    } as KbMessage);
    const { user, fake } = await openChat(/Lecture 8 — test/, world);
    const row = await screen.findByRole('group', { name: 'Marked unclear' });
    await waitFor(() => expect(row.textContent).toContain('Marked unclear'));
    expect(within(row).getByText('Marked unclear · 2')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Clear: How did Boltzmann write entropy?' }));
    await waitFor(() => expect(within(row).getByText('Marked unclear · 1')).toBeInTheDocument());
    await user.click(within(row).getByRole('button', { name: 'Clear now' }));
    expect(await within(row).findByText('Nothing is marked unclear now.')).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.path === '/kb/study/unclear/clear').map((c) => c.body))
      .toEqual([{ item_ids: ['q-1'] }, { item_ids: ['q-3'] }]);
  });
});

describe('P3-c: Ask the agent', () => {
  it('every question has it; it puts «📍 question N» and «Explain this question» in this chat’s field; Enter sends the chip', { timeout: 15_000 }, async () => {
    const { user, fake } = await openChat(/Lecture 8 — test/);
    const test = await screen.findByRole('region', { name: 'Test: Lecture 8 check' });
    for (let i = 0; i < 3; i += 1) {
      expect(within(test).getByRole('button', { name: 'Ask the agent' })).toBeInTheDocument();
      if (i < 2) await user.click(within(test).getByRole('button', { name: 'Next question' }));
    }
    await user.click(within(test).getByRole('button', { name: 'Previous question' }));
    await user.click(within(test).getByRole('button', { name: 'Previous question' }));
    await user.click(within(test).getByRole('button', { name: 'Ask the agent' }));
    const bar = await screen.findByRole('group', { name: 'Selection' });
    expect(bar).toHaveTextContent('question 1');
    expect(bar).toHaveTextContent('· Lecture 8 check');
    expect(within(bar).queryByRole('button', { name: /Where is this from/ })).toBeNull();
    await waitFor(() => expect(field()).toHaveTextContent(ASK_QUESTION_TEXT));
    expect(fake.calls.filter((c) => c.path.endsWith('/messages'))).toEqual([]); // nothing sent by itself
    await user.click(field());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages'))).toBeDefined());
    const body = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages'))!.body as Record<string, unknown>;
    expect(body.text).toBe(ASK_QUESTION_TEXT);
    expect(body.selection).toEqual({ message_id: expect.any(String), block_id: 'st-test', kind: 'study', title: 'Lecture 8 check',
      items: [{ id: 'q-1', label: 'question 1' }], intent: 'ask' });
    expect(await screen.findByRole('button', { name: 'Show the selection in the answer: question 1 · Lecture 8 check' })).toBeInTheDocument();
  });
});

describe('P3-a after the result (Q1 p3 M2)', () => {
  it('a report opened from the result keeps I did say this and Count it usable', { timeout: 15_000 }, async () => {
    const { user, fake } = await openChat(/Lecture 8 — test/);
    const test = await screen.findByRole('region', { name: 'Test: Lecture 8 check' });
    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.type(await within(test).findByRole('textbox', { name: 'Your answer' }), 'Because joined systems add up.');
    await user.click(within(test).getByRole('button', { name: 'Ask the agent to check' }));
    await within(test).findByRole('button', { name: 'Full review' }, { timeout: 5000 });
    await user.click(within(test).getByRole('button', { name: 'See result' }));
    const rows = await within(test).findByRole('list', { name: 'Answers' });
    const open = within(rows).getAllByRole('listitem').find((li) => li.textContent?.includes('logarithm'))!;
    await user.click(within(open).getByRole('button', { name: 'Review' }));
    await user.click(await within(test).findByRole('button', { name: 'Full review' }));
    const report = within(test).getByLabelText('Full review');
    const said = within(report).getAllByRole('button', { name: 'I did say this' });
    expect(said.length).toBeGreaterThan(0);
    for (const button of said) expect(button).toBeEnabled();
    await user.click(said[0]!);
    expect(within(report).getByRole('button', { name: 'Recheck' })).toBeEnabled();
    expect(fake.calls.filter((c) => c.path.endsWith('/recheck'))).toEqual([]);
  });
});

describe('Clear now row cost (Q1 p3 M6)', () => {
  it('the chat’s last answer that read the marks is found once per messages list, not once per message', () => {
    let reads = 0;
    const message = (i: number, unclear = false) => {
      const parts = unclear ? [{ type: 'tool', name: 'skaz_study_unclear', label: 'Read' }] : [{ type: 'text', text: `a${i}` }];
      return { id: `m${i}`, role: 'assistant', get parts() { reads += 1; return parts; } } as unknown as KbMessage;
    };
    const messages = [message(0, true), ...Array.from({ length: 199 }, (_, i) => message(i + 1))];
    // Every assistant message asks on every store change: 200 asks must not scan 200 × 200 parts lists.
    for (let i = 0; i < 200; i += 1) expect(lastUnclearAnswer(messages)).toBe('m0');
    expect(reads).toBe(200);
    const next = [...messages, message(200, true)]; // a new list (immutable update) is scanned again
    expect(lastUnclearAnswer(next)).toBe('m200');
    expect(lastUnclearAnswer([])).toBeNull();
  });
});

describe('Not yet is neutral (Q1 p3 L4, decision 3)', () => {
  it('a choice or short answer that is not yet right says so in grey with the open answer’s glyph, never in red', { timeout: 15_000 }, async () => {
    const { user } = await openChat(/Lecture 8 — test/);
    const test = await screen.findByRole('region', { name: 'Test: Lecture 8 check' });
    await user.click(within(test).getByRole('radio', { name: 'S = k·W²' }));
    await user.click(within(test).getByRole('button', { name: 'Check' }));
    const word = await within(test).findByText('Not yet.');
    const box = word.closest('.kb-st-res')!;
    expect(box).toHaveClass('is-not');
    expect(box).not.toHaveClass('is-bad');
    expect(box.querySelector('[data-icon="denied"]')).toBeNull();
    expect(box.querySelector('[data-icon="minus"]')).not.toBeNull();
    // Options keep their colours (decision 3, row 9): the wrong pick is still marked as such.
    expect(within(test).getByRole('radio', { name: /S = k·W²/ }).closest('.kb-st-opt')).toHaveClass('is-bad');
  });
});

describe('A11y (Q1 p3 L8)', () => {
  it('the Unclear mark is named by its words, not only its title; the count is live; additions link to notes by keyboard', { timeout: 15_000 }, async () => {
    const { user } = await openChat(/Lecture 8 — test/);
    const test = await screen.findByRole('region', { name: 'Test: Lecture 8 check' });
    // The words are hidden until hover, so the name may not depend on them (display:none drops it).
    expect(within(test).getByRole('button', { name: 'I have a question' })).toHaveAttribute('aria-label', 'I have a question');
    expect(test.querySelector('.kb-st-cnt')).toHaveAttribute('aria-live', 'polite');

    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.click(within(test).getByRole('button', { name: 'Next question' }));
    await user.type(await within(test).findByRole('textbox', { name: 'Your answer' }), 'Because joined systems add up.');
    await user.click(within(test).getByRole('button', { name: 'Ask the agent to check' }));
    await user.click(await within(test).findByRole('button', { name: 'Full review' }, { timeout: 5000 }));
    const report = within(test).getByLabelText('Full review');
    const addition = within(report).getByText('their arrangements multiply,');
    expect(addition).toHaveAttribute('tabindex', '0');
    const note = document.getElementById(addition.getAttribute('aria-describedby') ?? '');
    expect(note?.tagName).toBe('LI');
    act(() => addition.focus());
    expect(note).toHaveClass('is-hot');
    act(() => addition.blur());
    expect(note).not.toHaveClass('is-hot');
  });
});
