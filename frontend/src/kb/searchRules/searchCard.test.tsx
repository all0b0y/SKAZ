import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbChat, KbWebSearchPart } from '../../api/kb/types.gen';
import { chatMessage, type FakeWorld } from '../test/fakeKb';
import { ago, chatWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import type { AnyMessagePart } from '../api/permissions';

// N7 on the search card: the rules in force and where they come from, links hidden by them (counted,
// sites on click), «Search everywhere once» only on the user's click, a query refused by the rules.

const RULES = { never: ['pinterest.com', 'quora.com', 'medium.com'], settings_never: ['pinterest.com', 'quora.com', 'medium.com'], only: [], prefer: ['arxiv.org', 'aclanthology.org'], origin: 'settings' as const, everywhere_once: false };

function part(id: string, extra: Partial<KbWebSearchPart> = {}): KbWebSearchPart {
  return {
    type: 'web_search', id, engine: 'codex', searcher: 'codex', query: 'detecting outdated claims in wikis 2025', allowed_domains: [], blocked_domains: [],
    status: 'pending', auto: false, reason: null, links: [], rules: RULES, hidden: [], ...extra,
  };
}

function world(parts: AnyMessagePart[], streaming = false): FakeWorld {
  const w = chatWorld();
  const chat: KbChat = {
    id: 'c30', title: 'Wiki trust', pinned: false, engine: 'codex', model: 'gpt', effort: 'medium', created_at: ago(9), updated_at: ago(1),
    last_preview: '', recording_material_id: null, folder_ids: [], state: streaming ? 'answering' : 'idle', unread: false, cursor: 0,
    messages: [
      chatMessage('c30-u1', 1, 'user', ago(2), [{ type: 'text', text: 'Find recent work' }]),
      chatMessage('c30-a1', 2, 'assistant', ago(1), parts as KbChat['messages'][number]['parts'], { state: streaming ? 'streaming' : 'done' }),
    ],
  };
  w.chats.push(chat);
  w.chatEvents.c30 = [];
  return w;
}

async function open(w: FakeWorld) {
  const user = userEvent.setup();
  const view = renderKb({ world: w });
  await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Wiki trust/ }));
  return { user, ...view, centre: () => screen.getByRole('region', { name: 'Chat' }) };
}

describe('Search card with the user’s rules (N7)', () => {
  it('shows the rules in force and where they come from while it asks', async () => {
    const { centre } = await open(world([part('web-1')], true));
    const card = await within(centre()).findByRole('region', { name: 'Codex wants to search the web' });
    const rules = within(card).getByLabelText('Search rules');
    expect(rules).toHaveTextContent('Prefer: arxiv.org, aclanthology.org');
    expect(rules).toHaveTextContent('Never: pinterest.com +2');
    expect(rules).toHaveTextContent('· Settings');
  });

  it('counts the links the rules hid; the sites show on click', async () => {
    const links = [{ title: 'Staleness checks', url: 'https://arxiv.org/abs/1', site: 'arxiv.org' }];
    const hidden = [{ site: 'pinterest.com', count: 2 }, { site: 'medium.com', count: 1 }];
    const { user, centre } = await open(world([part('web-2', { status: 'allowed', links, hidden })]));
    const button = await within(centre()).findByRole('button', { name: '· 3 hidden by your rules' });
    await user.click(button);
    const pop = await screen.findByRole('dialog', { name: 'Links hidden by your rules' });
    expect(pop).toHaveTextContent('pinterest.com · 2');
    expect(pop).toHaveTextContent('medium.com');
    expect(pop).toHaveTextContent('SKAZ removed these links before the agent got the results');
  });

  it('on Claude’s own search the hidden links are said to be hidden on the card only (Q1 n78 H-2)', async () => {
    const links = [{ title: 'Staleness checks', url: 'https://arxiv.org/abs/1', site: 'arxiv.org' }];
    const native = part('web-5', { engine: 'claude_code', searcher: null, status: 'allowed', links, hidden: [{ site: 'pinterest.com', count: 1 }] });
    const { user, centre } = await open(world([native]));
    await user.click(await within(centre()).findByRole('button', { name: '· 1 hidden by your rules' }));
    const pop = await screen.findByRole('dialog', { name: 'Links hidden by your rules' });
    expect(pop).toHaveTextContent('Hidden on this card only');
    expect(pop).not.toHaveTextContent('before the agent got the results');
  });

  it('nothing on the allowed sites: «Search everywhere once» is the user’s click and asks the backend once', async () => {
    const rules = { ...RULES, only: ['arxiv.org', 'semanticscholar.org'], origin: 'chat' as const };
    const { user, centre, fake } = await open(world([part('web-3', { status: 'allowed', execution: 'done', rules, hidden: [{ site: 'medium.com', count: 4 }] })]));
    const box = await within(centre()).findByRole('group', { name: 'Nothing on the allowed sites' });
    expect(box).toHaveTextContent('Only these sites are allowed in this chat. Blocked sites stay blocked.');
    expect(fake.calls.filter((c) => c.path.endsWith('/everywhere-once'))).toEqual([]);
    await user.click(within(box).getByRole('button', { name: 'Search everywhere once' }));
    await waitFor(() => expect(within(box).getByRole('status')).toHaveTextContent('The next search in this chat looks everywhere, once.'));
    expect(fake.calls.filter((c) => c.path.endsWith('/everywhere-once')).map((c) => [c.method, c.path])).toEqual([
      ['POST', '/kb/chats/c30/search-rules/everywhere-once'],
    ]);
  });

  it('a query whose sites are all blocked is refused by the rules, nothing sent', async () => {
    const { centre } = await open(world([part('web-4', { status: 'denied', auto: true, reason: 'blocked' })]));
    expect(await within(centre()).findByRole('group', { name: /^Search blocked by your rules/ })).toHaveTextContent('Nothing was sent');
    expect(within(centre()).queryByRole('button', { name: 'Search everywhere once' })).toBeNull(); // no «only» list
  });

  it('a search blocked by «only these sites» offers «Search everywhere once» too (Q1 n78 L-7)', async () => {
    const rules = { ...RULES, only: ['arxiv.org'], origin: 'chat' as const };
    const { centre } = await open(world([part('web-6', { status: 'denied', auto: true, reason: 'blocked', rules })]));
    const box = await within(centre()).findByRole('group', { name: 'Nothing on the allowed sites' });
    expect(within(box).getByRole('button', { name: 'Search everywhere once' })).toBeInTheDocument();
  });
});
