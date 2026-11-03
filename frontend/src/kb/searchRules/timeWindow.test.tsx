import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbChat, KbWebSearchPart } from '../../api/kb/types.gen';
import { chatMessage, type FakeWorld } from '../test/fakeKb';
import { ago, chatWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import { splitWindow } from './TimeWindow';

// N7-5 · «what now»: the window line becomes a chip changed in one click; the year in the query is
// visible on the card; web links of a time-bound search say «date unknown».

const search: KbWebSearchPart = {
  type: 'web_search', id: 'web-9', engine: 'codex', searcher: 'codex', query: 'wiki staleness detection 2025 2026', allowed_domains: [], blocked_domains: [],
  status: 'allowed', execution: 'done', auto: false, reason: null, rules: null, hidden: [],
  links: [{ title: 'Detecting outdated statements', url: 'https://aclanthology.org/x', site: 'aclanthology.org' }],
};

function world(): FakeWorld {
  const w = chatWorld();
  const chat: KbChat = {
    id: 'c60', title: 'What now', pinned: false, engine: 'codex', model: 'gpt', effort: 'medium', created_at: ago(5), updated_at: ago(1),
    last_preview: '', recording_material_id: null, folder_ids: [], state: 'idle', unread: false, cursor: 0,
    messages: [
      chatMessage('u1', 1, 'user', ago(2), [{ type: 'text', text: 'What are the modern approaches?' }]),
      chatMessage('a1', 2, 'assistant', ago(1), [search, { type: 'text', text: 'Looking at 2024–2026\n\nFrom 2025–2026 sources: claim-level checks.' }]),
    ],
  };
  w.chats.push(chat);
  w.chatEvents.c60 = [];
  return w;
}

describe('time window line', () => {
  it('is taken out of the first text part', () => {
    const { window, parts } = splitWindow([{ type: 'text', text: '**Looking at 2024-2026**\nThe rest.' }]);
    expect(window).toEqual({ from: 2024, to: 2026 });
    expect(parts).toEqual([{ type: 'text', text: 'The rest.' }]);
    expect(splitWindow([{ type: 'text', text: 'No window here. Looking at 2024–2026' }]).window).toBeNull();
  });
});

describe('«what now» answers (N7-5)', () => {
  it('show the window as a chip; another window is one click and asks again', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: world() });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /What now/ }));
    const article = await screen.findByRole('article', { name: 'Answer' });
    const chip = await within(article).findByRole('button', { name: 'Looking at 2024–2026. Change the time window' });
    expect(article).not.toHaveTextContent('Looking at 2024–2026From');
    expect(article).toHaveTextContent('From 2025–2026 sources: claim-level checks.');
    await user.click(chip);
    const menu = await screen.findByRole('menu', { name: 'Time window' });
    const year = new Date().getFullYear();
    await user.click(within(menu).getByRole('menuitem', { name: new RegExp(`Last 5 years \\(${year - 4}–${year}\\)`) }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/chats/c60/messages', body: expect.objectContaining({ text: `Look at ${year - 4}–${year} instead.` }),
    })));
  });

  it('the card marks the year of the query and says «date unknown» for its links', async () => {
    const user = userEvent.setup();
    renderKb({ world: world() });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /What now/ }));
    const fold = await screen.findByRole('button', { name: /Searched the web · wiki staleness detection 2025 2026/ });
    await user.click(fold);
    const links = await screen.findByRole('list', { name: 'From the web' });
    expect(links).toHaveTextContent('date unknown');
  });
});
