import { expect, it } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbAnswerBlockPart, KbMessagePart } from '../../api/kb/types.gen';
import { chatWorld } from '../test/fixtures';
import { chatMessage } from '../test/fakeKb';
import { renderKb } from '../test/renderKb';

async function open(parts: KbMessagePart[], state: 'done' | 'streaming' = 'done') {
  const world = chatWorld();
  world.chats.find((c) => c.id === 'c1')!.messages = [chatMessage('knowledge-answer', 1, 'assistant',
    new Date().toISOString(), parts, { state })];
  const view = renderKb({ world });
  act(() => view.services.chats.getState().open('c1'));
  await within(screen.getByRole('region', { name: 'Chat' })).findByText('A controlled explanation.');
  return { ...view, user: userEvent.setup() };
}

for (const state of ['done', 'streaming'] as const) it(`general knowledge is one informational fold, never approval — ${state}`, async () => {
  const { user, fake } = await open([
    { type: 'knowledge' }, { type: 'knowledge' }, { type: 'text', text: 'A controlled explanation.' },
  ], state);
  const notes = screen.getAllByRole('note', { name: 'Using general knowledge' });
  expect(notes).toHaveLength(1);
  const note = notes[0]!;
  const button = within(note).getByRole('button', { name: 'Using general knowledge' });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(within(note).queryByRole('timer')).toBeNull();
  expect(within(note).queryByRole('button', { name: /Allow|Deny/ })).toBeNull();
  await user.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(note).toHaveTextContent('not evidence from your materials');
  expect(note).not.toHaveTextContent('not found');
  expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
});

it('a validated own-knowledge block also discloses its basis when the marker was omitted', async () => {
  const block: KbAnswerBlockPart = {
    type: 'answer_block', id: 'knowledge-block', state: 'ready', error: null, hidden: 0, raw: null,
    sources: [], beside: false, link: null, markdown: null,
    block: { kind: 'definition', title: null, term: 'Controlled term', also: [],
      definition: { id: 'definition', text: 'A general definition.', src: [], agent: true }, example: null },
  };
  await open([{ type: 'text', text: 'A controlled explanation.' }, block]);
  expect(screen.getByRole('note', { name: 'Using general knowledge' })).toBeInTheDocument();
});

it('uncited ordinary text alone does not pretend that the application observed a memory search', async () => {
  await open([{ type: 'text', text: 'A controlled explanation.' }]);
  expect(screen.queryByRole('note', { name: 'Using general knowledge' })).toBeNull();
});
