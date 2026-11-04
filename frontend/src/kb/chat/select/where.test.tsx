import { beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { FLOW, LECTURE, openAnswer, steps } from './testing';

// P2 step 3: «Where is this from?» — SKAZ shows the picked items' sources itself, no agent call.

beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });

describe('P2: Where is this from?', () => {
  it('lists each picked item with its sources (open-able) and the agent’s own knowledge; nothing is sent', async () => {
    const { user, chat, fake } = await openAnswer([steps]);
    const block = within(chat).getByRole('region', { name: 'Steps: Leader election' });
    for (const text of ['Count the microstates', 'Take the logarithm', 'Multiply by k']) await user.click(within(block).getByText(text));
    await user.click(within(chat).getByRole('button', { name: 'Where is this from?' }));
    const where = within(chat).getByRole('region', { name: 'Where this is from' });
    expect(within(chat).getByRole('button', { name: 'Where is this from?' })).toHaveAttribute('aria-expanded', 'true');
    const rows = [...where.querySelectorAll('.kb-where__row')].map((row) => row.textContent);
    expect(rows).toEqual([
      'Count the microstates WLecture 843:20',
      'Take the logarithmEntropywiki',
      'Multiply by kAgent’s knowledge — not from your materials',
    ]);
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/chats/c1/messages')).toHaveLength(0);
    await user.click(within(where).getByRole('button', { name: 'Open source: Lecture 8 · 43:20' }));
    expect(await screen.findByRole('complementary', { name: 'Document' })).toBeInTheDocument();
    await user.click(within(where).getByRole('button', { name: 'Close' }));
    expect(within(chat).queryByRole('region', { name: 'Where this is from' })).toBeNull();
  });

  it('a diagram: the sources cited right after it, for the whole diagram — or it says there are none', async () => {
    const { user, chat } = await openAnswer([
      { type: 'text', text: `Cited:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n` }, LECTURE,
      { type: 'text', text: '\nUncited:\n\n```mermaid\nflowchart TD\n  X[Alone] --> Y[Too]\n```\nThe end.\n\n' },
    ]);
    const [cited, bare] = await within(chat).findAllByRole('figure', { name: 'Diagram' });
    await waitFor(() => expect(cited!.querySelector('[data-item-id="node:A"]')).not.toBeNull());
    await user.click(cited!.querySelector('[data-item-id="node:A"]')!);
    await user.click(within(chat).getByRole('button', { name: 'Where is this from?' }));
    let where = within(chat).getByRole('region', { name: 'Where this is from' });
    expect(where).toHaveTextContent('The whole diagram');
    expect(within(where).getByRole('button', { name: 'Open source: Lecture 8 · 43:20' })).toBeInTheDocument();
    expect(where).toHaveTextContent('A diagram’s nodes have no sources of their own');
    await waitFor(() => expect(bare!.querySelector('[data-item-id="node:X"]')).not.toBeNull());
    await user.click(bare!.querySelector('[data-item-id="node:X"]')!);
    // Another block: the panel closes with the old selection; asked again, it shows this one.
    expect(within(chat).queryByRole('region', { name: 'Where this is from' })).toBeNull();
    await user.click(within(chat).getByRole('button', { name: 'Where is this from?' }));
    where = within(chat).getByRole('region', { name: 'Where this is from' });
    expect(where).toHaveTextContent('This diagram cites no sources.');
  });
});
