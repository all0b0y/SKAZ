import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbMessage, KbStudyPart } from '../../api/kb/types.gen';
import { studyWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import { DISCUSS_UNCLEAR_TEXT } from './Unclear';

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
