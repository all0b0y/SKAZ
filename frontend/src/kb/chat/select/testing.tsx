import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbAnswerBlockPart, KbCitation, KbMessagePart } from '../../../api/kb/types.gen';
import { renderKb } from '../../test/renderKb';
import { chatWorld } from '../../test/fixtures';
import { chatMessage } from '../../test/fakeKb';

// Shared by the P2 tests: an answer with blocks or diagrams in chat c1, opened.

const cite = (seg: number, start_ms: number): KbCitation => ({
  material_id: 'm1', seg, available: true, material_title: 'Lecture 8', start_ms, end_ms: null, page: null, quote: null,
});
export const LECTURE = { type: 'cite' as const, citation: cite(1, 2_600_000) };
export const PAGE = { type: 'page' as const, page: { id: 'p-entropy', kind: 'concept' as const, title: 'Entropy' }, block_id: 'c-e1', available: true };

/**
 * A ready answer-block part with the fields every block part has. One helper on purpose: when the
 * part gains fields (P1b: beside, link, markdown), only this function changes.
 */
export function blockPart(id: string, sources: KbAnswerBlockPart['sources'], block: KbAnswerBlockPart['block'],
  compose: Partial<Pick<KbAnswerBlockPart, 'beside' | 'link'>> = {}): KbAnswerBlockPart {
  return { type: 'answer_block', id, state: 'ready', hidden: 0, error: null, raw: null, sources, block,
    beside: false, link: null, markdown: null, ...compose };
}

export const steps: KbAnswerBlockPart = blockPart('blk-st', [LECTURE, PAGE], { kind: 'steps', title: 'Leader election', steps: [
    { id: 's1', src: [0], agent: false, title: 'Count the microstates', text: 'W' },
    { id: 's2', src: [1], agent: false, title: 'Take the logarithm', text: null },
    { id: 's3', src: [], agent: true, title: 'Multiply by k', text: null },
  ] });
export const timeline: KbAnswerBlockPart = blockPart('blk-tl', [LECTURE], { kind: 'timeline', title: null, events: [
  { id: 'e1', src: [0], agent: false, when: null, title: 'Why a logarithm', text: null },
] });
export const FLOW = 'flowchart LR\n  A[Timeout] --> B(Candidate)\n  B -->|votes| C{Majority?}\n  C -- yes --> D[Leader]';

export async function openAnswer(parts: KbMessagePart[]) {
  const user = userEvent.setup();
  const world = chatWorld();
  const c1 = world.chats.find((c) => c.id === 'c1')!;
  c1.messages.push(chatMessage('c1-a2', 3, 'assistant', new Date().toISOString(),
    [{ type: 'text', text: 'In short:\n' }, ...parts, { type: 'text', text: 'That is all.' }]));
  c1.cursor = 3;
  const r = renderKb({ world });
  await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
  const chat = screen.getByRole('region', { name: 'Chat' });
  await within(chat).findByText('That is all.');
  return { user, chat, world, ...r };
}
