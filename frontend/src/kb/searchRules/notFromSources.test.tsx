import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbChat } from '../../api/kb/types.gen';
import { chatMessage, type FakeWorld } from '../test/fakeKb';
import { ago, chatWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import { notFromSources } from './NotFromSources';

// N7-4 citation check: with «Use only these sources», citations outside the set are counted under the answer.

const cite = (id: string, seg: number) => ({ type: 'cite' as const, citation: { material_id: id, seg, available: true, material_title: id, start_ms: null, end_ms: null, page: null } });
const answer = chatMessage('a1', 2, 'assistant', ago(1), [
  { type: 'text', text: 'Entropy grows.' }, cite('m1', 1), cite('m2', 3), cite('m2', 4),
  { type: 'text', text: ' It is a measure.' }, cite('m4', 1),
  { type: 'page', page: { id: 'p-entropy', kind: 'concept', title: 'Entropy' }, block_id: null },
]);

function world(only: boolean, since: string | null = null): FakeWorld {
  const w = chatWorld();
  const chat: KbChat = {
    id: 'c50', title: 'Strict sources', pinned: false, engine: 'codex', model: 'gpt', effort: 'medium', created_at: ago(5), updated_at: ago(1),
    last_preview: '', recording_material_id: null, folder_ids: [], state: 'idle', unread: false, cursor: 0,
    messages: [chatMessage('u1', 1, 'user', ago(2), [{ type: 'text', text: 'What is entropy?' }]), answer],
  };
  w.chats.push(chat);
  w.chatEvents.c50 = [];
  w.chatSearchRules = { c50: { web: null, sources_only: only, sources: ['m1', 'p-entropy'], excluded: ['m4'], everywhere_once: false, sources_since: since } };
  return w;
}

describe('statements not from your sources (N7-4)', () => {
  it('counts statements (not citations) outside the chosen set or excluded', () => {
    // Two cites of m2 back one statement; m4 backs the next: two statements (Q1 n78 M-7).
    expect(notFromSources(answer, ['m1', 'p-entropy'], ['m4'])).toBe(2);
    expect(notFromSources(answer, ['m1', 'm4', 'p-entropy'], [])).toBe(1);
    expect(notFromSources(answer, ['m1', 'm2', 'm4', 'p-entropy'], [])).toBe(0);
  });

  it('shows the line under an answer only in «Only these» mode', async () => {
    const user = userEvent.setup();
    renderKb({ world: world(true) });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Strict sources/ }));
    const article = await screen.findByRole('article', { name: 'Answer' });
    expect(await within(article).findByRole('note')).toHaveTextContent('2 statements not from your sources');
  });

  it('is not stamped on answers written before the sources were set (Q1 n78 M-7)', async () => {
    const user = userEvent.setup();
    renderKb({ world: world(true, new Date().toISOString()) });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Strict sources/ }));
    const article = await screen.findByRole('article', { name: 'Answer' });
    await within(article).findByText(/Entropy grows/);
    expect(within(article).queryByText(/not from your sources/)).toBeNull();
  });

  it('says nothing when the chat uses all sources', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: world(false) });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Strict sources/ }));
    const article = await screen.findByRole('article', { name: 'Answer' });
    await within(article).findByText(/Entropy grows/);
    expect(fake.calls.filter((c) => c.path === '/kb/chats/c50/search-rules')).toHaveLength(1); // one read per chat
    expect(within(article).queryByText(/not from your sources/)).toBeNull();
  });
});
