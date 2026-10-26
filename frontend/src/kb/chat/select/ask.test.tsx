import { beforeAll, describe, expect, it, vi } from 'vitest';
import { waitFor, within } from '@testing-library/react';
import type { KbSend } from '../../../api/kb/types.gen';
import { FLOW, openAnswer, steps } from './testing';
import { diagramId } from './model';

// P2 step 2: asking about the selection — the field, the quick asks, the chip on the question.

beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });

type Fake = Awaited<ReturnType<typeof openAnswer>>['fake'];
const sent = (fake: Fake) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/chats/c1/messages')
  .map((c) => c.body as KbSend);

describe('P2: asking about the selection', () => {
  it('a typed question goes with the selection (ids, labels, the block); the bar clears; the question shows a chip', async () => {
    const { user, chat, fake } = await openAnswer([steps]);
    const block = within(chat).getByRole('region', { name: 'Steps: Leader election' });
    await user.click(within(block).getByText('Count the microstates'));
    await user.click(within(block).getByText('Multiply by k'));
    await user.click(within(chat).getByRole('textbox', { name: 'Message' }));
    await user.keyboard('Why these two?{Enter}');
    await waitFor(() => expect(sent(fake)).toHaveLength(1));
    expect(sent(fake)[0]).toMatchObject({
      text: 'Why these two?',
      selection: { message_id: 'c1-a2', block_id: 'blk-st', kind: 'block', title: 'Leader election', intent: 'ask',
        items: [{ id: 's1', label: 'Count the microstates W' }, { id: 's3', label: 'Multiply by k' }] },
    });
    await waitFor(() => expect(within(chat).queryByRole('group', { name: 'Selection' })).toBeNull());
    expect(block.querySelector('[data-selected="true"]')).toBeNull();
    const question = (await within(chat).findAllByRole('article', { name: 'Your question' })).at(-1)!;
    const chip = within(question).getByRole('button', { name: /Show the selection in the answer/ });
    expect(chip).toHaveTextContent('2 items · Leader election');
    // The chip lights the items in the old answer, which itself is unchanged.
    await user.click(chip);
    expect([...block.querySelectorAll('[data-flash="true"]')].map((el) => el.getAttribute('data-item-id'))).toEqual(['s1', 's3']);
  });

  it('«That’s wrong» sends at once with what was typed; «Explain more» alone is its own words', async () => {
    const { user, chat, fake } = await openAnswer([steps, { type: 'text', text: `\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n` }]);
    const block = within(chat).getByRole('region', { name: 'Steps: Leader election' });
    await user.click(within(block).getByText('Take the logarithm'));
    await user.click(within(chat).getByRole('textbox', { name: 'Message' }));
    await user.keyboard('it is the other way round');
    await user.click(within(chat).getByRole('button', { name: /That’s wrong/ }));
    await waitFor(() => expect(sent(fake)).toHaveLength(1));
    expect(sent(fake)[0]).toMatchObject({ text: 'That’s wrong: it is the other way round',
      selection: { block_id: 'blk-st', intent: 'wrong', items: [{ id: 's2' }] } });
    expect(within(chat).getByRole('textbox', { name: 'Message' })).toHaveTextContent('');

    const figure = within(chat).getByRole('figure', { name: 'Diagram' });
    await waitFor(() => expect(figure.querySelector('[data-item-id="node:D"]')).not.toBeNull());
    await user.click(figure.querySelector('[data-item-id="node:D"]')!);
    const explain = within(chat).getByRole('button', { name: /Explain more/ });
    await waitFor(() => expect(explain).not.toHaveAttribute('aria-disabled'));
    await user.click(explain);
    await waitFor(() => expect(sent(fake)).toHaveLength(2));
    expect(sent(fake)[1]).toMatchObject({ text: 'Explain more',
      selection: { block_id: diagramId(FLOW), kind: 'diagram', intent: 'explain', items: [{ id: 'node:D', label: 'Leader' }] } });
  });
});
