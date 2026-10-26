import { beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { KbWikiFixPart } from '../../../api/kb/types.gen';
import { openAnswer } from './testing';

// P2 step 4: «Fix in wiki» — before → after; the wiki changes only on the user's click.

beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });

const fix: KbWikiFixPart = {
  type: 'wiki_fix', id: 'fix-1', page: { id: 'p-entropy', kind: 'concept', title: 'Entropy' }, block_id: 'c-e1',
  before: 'Sends RequestVote to all nodes', after: 'Sends RequestVote to all other nodes',
  reason: 'The lecture says the candidate already voted for itself.', status: 'proposed', available: true,
};

const applied = (fake: Awaited<ReturnType<typeof openAnswer>>['fake']) =>
  fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/wiki-fixes/fix-1/apply'));

describe('P2: Fix in wiki', () => {
  it('shows the block before → after; nothing is written until «Fix in wiki»; then it says so', async () => {
    const { user, chat, fake } = await openAnswer([{ type: 'text', text: 'Checked against the sources.\n\n' }, fix]);
    const card = within(chat).getByRole('region', { name: 'Wiki fix: Entropy' });
    const diff = within(card).getByRole('group', { name: 'Before and after' });
    expect(diff).toHaveTextContent('WasSends RequestVote to all nodes');
    expect(diff).toHaveTextContent('NowSends RequestVote to all other nodes');
    expect(card).toHaveTextContent('Changes the wiki only when you click');
    expect(card).toHaveTextContent('The lecture says the candidate already voted for itself.');
    expect(applied(fake)).toHaveLength(0);
    await user.click(within(card).getByRole('button', { name: 'Fix in wiki' }));
    await waitFor(() => expect(applied(fake)).toHaveLength(1));
    expect(applied(fake)[0]!.path).toBe('/kb/chats/c1/messages/c1-a2/wiki-fixes/fix-1/apply');
    expect(await within(card).findByText(/Fixed in wiki — edited by you/)).toHaveAttribute('role', 'status');
    expect(within(card).queryByRole('button', { name: 'Fix in wiki' })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Wiki · Entropy' }));
    expect(await screen.findByRole('complementary', { name: 'Document' })).toBeInTheDocument();
  });

  it('a block that changed since the proposal is left alone, and the card says so', async () => {
    const { user, chat, fake } = await openAnswer([fix]);
    fake.world.wikiFixStale = true;
    const card = within(chat).getByRole('region', { name: 'Wiki fix: Entropy' });
    await user.click(within(card).getByRole('button', { name: 'Fix in wiki' }));
    expect(await within(card).findByText(/The page changed since this was proposed — nothing was written\./)).toHaveAttribute('role', 'status');
    expect(applied(fake)).toHaveLength(1);
  });
});
