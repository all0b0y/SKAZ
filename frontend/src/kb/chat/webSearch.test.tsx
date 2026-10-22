import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbChat, KbWebSearchPart } from '../../api/kb/types.gen';
import { chatMessage, serveFake, type FakeWorld } from '../test/fakeKb';
import { agent, ago, chatWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import type { AnyMessagePart } from '../api/permissions';
import { WebSearchNote, searchScopeNote } from './webSearch';

// W-2: an agent's own web search — the exact query is shown and held until Allow once / Allow in
// this chat / Deny; web links stay apart from the material citations, each with "Add to wiki".

const LINKS = [
  { title: 'Second law of thermodynamics — Wikipedia', url: 'https://en.wikipedia.org/wiki/Second_law', site: 'en.wikipedia.org' },
  { title: 'Paywalled article', url: 'https://news.example.com/signin/entropy', site: 'news.example.com' },
];

function webPart(id: string, extra: Partial<KbWebSearchPart> = {}): KbWebSearchPart {
  return {
    type: 'web_search', id, engine: 'claude_code', query: 'second law of thermodynamics history', allowed_domains: [], blocked_domains: [],
    status: 'pending', auto: false, reason: null, links: [], ...extra,
  };
}

function webWorld(): FakeWorld {
  const w = chatWorld();
  const chat = (id: string, title: string, minutes: number, parts: AnyMessagePart[], streaming: boolean): KbChat => ({
    id, title, pinned: false, engine: 'claude_code', model: 'opus', effort: 'medium', created_at: ago(minutes + 5), updated_at: ago(minutes),
    last_preview: '', recording_material_id: null, folder_ids: [], state: streaming ? 'answering' : 'idle', unread: false, cursor: 0,
    messages: [
      chatMessage(`${id}-u1`, 1, 'user', ago(minutes + 1), [{ type: 'text', text: 'Who stated the second law?' }]),
      chatMessage(`${id}-a1`, 2, 'assistant', ago(minutes), parts as KbChat['messages'][number]['parts'], { state: streaming ? 'streaming' : 'done' }),
    ],
  });
  w.chats.push(
    chat('c20', 'Second law — web', 1, [{ type: 'text', text: 'Let me look this up.' }, webPart('web-1')], true),
    // W-3b: a Hermes chat's query, searched by Claude Code's own search in a separate run.
    chat('c22', 'Hermes — web', 3, [webPart('web-5', { engine: 'hermes', searcher: 'claude_code', query: 'entropy definition' })], true),
    chat('c23', 'Codex — web', 4, [webPart('web-6', { engine: 'codex', searcher: 'codex', query: 'entropy definition' })], true),
    chat('c21', 'Clausius — searched', 2, [
      webPart('web-2', { status: 'allowed', links: LINKS }),
      webPart('web-3', { status: 'allowed', auto: true, query: 'Clausius 1850 paper' }),
      webPart('web-4', { status: 'denied', query: 'my lecture notes' }),
      { type: 'text', text: 'Clausius stated it in 1850.' },
    ], false),
  );
  w.webGrants = { c21: '2026-10-21T10:00:00Z' };
  for (const id of ['c20', 'c21', 'c22', 'c23']) w.chatEvents[id] = [];
  return w;
}

const side = () => screen.getByRole('region', { name: 'Chats' });
const centre = () => screen.getByRole('region', { name: 'Chat' });
async function openChat(name: RegExp) {
  const user = userEvent.setup();
  const view = renderKb({ world: webWorld() });
  await user.click(await within(side()).findByRole('button', { name }));
  return { user, ...view };
}
const webCalls = (fake: { calls: Array<{ method: string; path: string; body?: unknown }> }) =>
  fake.calls.filter((c) => /web-search|materials\/web/.test(c.path)).map((c) => [c.method, c.path, c.body ?? null]);

describe('Fake backend: web search routes (W-2)', () => {
  it('decide once / in this chat / deny; a second decision is 409; the grant is read and revoked', () => {
    const w = webWorld();
    const post = (path: string, body: unknown) => serveFake(w, { method: 'POST', path, body });
    expect(post('/kb/web-searches/web-1/decide', { decision: 'allow_chat' })).toMatchObject({ ok: true, data: { id: 'web-1', status: 'allowed' } });
    expect(post('/kb/web-searches/web-1/decide', { decision: 'deny' })).toMatchObject({ ok: false, status: 409 });
    expect(serveFake(w, { method: 'GET', path: '/kb/chats/c20/web-search' })).toMatchObject({ ok: true, data: { allowed: true } });
    expect(serveFake(w, { method: 'DELETE', path: '/kb/chats/c20/web-search' })).toMatchObject({ ok: true, data: { allowed: false, granted_at: null } });
    expect(post('/kb/web-searches/nope/decide', { decision: 'allow' })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('Web search card in the chat', () => {
  it('shows the exact query and what leaves SKAZ before anything is sent; Allow once sends only the decision', async () => {
    const { user, fake } = await openChat(/Second law — web/);
    const card = await within(centre()).findByRole('region', { name: 'Claude Code wants to search the web' });
    expect(within(card).getByLabelText('Search query')).toHaveTextContent('second law of thermodynamics history');
    // Decision 8 (2026-10-21): Claude Code's search may rephrase the approved query up to 8 times
    // inside Anthropic's search model — the card says so, honestly and briefly.
    expect(card).toHaveTextContent('Claude may rephrase it for up to 8 searches; nothing else from the chat or your library is sent.');
    expect(card).not.toHaveTextContent('Only this query is sent');
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['Deny', 'Allow in this chat', 'Allow once']);
    await user.click(within(card).getByRole('button', { name: 'Allow once' }));
    expect(webCalls(fake)).toContainEqual(['POST', '/kb/web-searches/web-1/decide', { decision: 'allow' }]);
    expect(await within(centre()).findByRole('group', { name: 'Searched the web: second law of thermodynamics history' })).toBeInTheDocument();
  });

  it('W-3b: a query of Codex, Hermes or OpenCode says whose own search runs it, in a separate run', async () => {
    const { user, fake } = await openChat(/Hermes — web/);
    const card = await within(centre()).findByRole('region', { name: 'Hermes wants to search the web' });
    expect(within(card).getByLabelText('Search query')).toHaveTextContent('entropy definition');
    expect(card).toHaveTextContent('Searched by Claude Code in a separate run that gets only this query.');
    expect(card).toHaveTextContent('Claude may rephrase it for up to 8 searches');
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['Deny', 'Allow in this chat', 'Allow once']);
    await user.click(within(card).getByRole('button', { name: 'Allow once' }));
    expect(webCalls(fake)).toContainEqual(['POST', '/kb/web-searches/web-5/decide', { decision: 'allow' }]);
  });

  it('W-3b: Codex searching its own chat\'s query says so too', async () => {
    await openChat(/Codex — web/);
    const card = await within(centre()).findByRole('region', { name: 'Codex wants to search the web' });
    expect(card).toHaveTextContent('Searched by Codex in a separate run that gets only this query.');
    expect(card).toHaveTextContent('Codex may rephrase it for its searches; nothing else from the chat or your library is sent.');
  });

  it('a Claude Code query (its own search) has no separate-run line', async () => {
    await openChat(/Second law — web/);
    const card = await within(centre()).findByRole('region', { name: 'Claude Code wants to search the web' });
    expect(card).not.toHaveTextContent('separate run');
  });

  it('Allow in this chat shows the header chip', async () => {
    const { user, fake } = await openChat(/Second law — web/);
    const card = await within(centre()).findByRole('region', { name: 'Claude Code wants to search the web' });
    await user.click(within(card).getByRole('button', { name: 'Allow in this chat' }));
    expect(webCalls(fake)).toContainEqual(['POST', '/kb/web-searches/web-1/decide', { decision: 'allow_chat' }]);
    expect(await within(centre()).findByRole('button', { name: /Web search allowed in this chat/ })).toBeInTheDocument();
  });

  it('Deny says nothing was sent', async () => {
    const { user } = await openChat(/Second law — web/);
    const card = await within(centre()).findByRole('region', { name: 'Claude Code wants to search the web' });
    await user.click(within(card).getByRole('button', { name: 'Deny' }));
    const done = await within(centre()).findByRole('group', { name: 'Search denied: second law of thermodynamics history' });
    expect(done).toHaveTextContent('Nothing was sent');
  });

  it('web links stay apart from the sources, with their sites; searches without a question say so', async () => {
    const { user } = await openChat(/Clausius — searched/);
    // Web results v1 «Folded line + quiet rows» (2026-10-21): folded by default into one line.
    const toggle = await within(centre()).findByRole('button', { name: /Searched the web · second law of thermodynamics history · 2 links/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(centre()).queryByRole('list', { name: 'From the web' })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const web = await within(centre()).findByRole('list', { name: 'From the web' });
    const rows = within(web).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const link = within(rows[0]!).getByRole('link', { name: 'Second law of thermodynamics — Wikipedia' });
    expect(link).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Second_law');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    expect(rows[0]).toHaveTextContent('en.wikipedia.org');
    await user.click(toggle);
    expect(within(centre()).queryByRole('list', { name: 'From the web' })).not.toBeInTheDocument();
    expect(within(centre()).getByRole('group', { name: 'Searched the web · allowed in this chat: Clausius 1850 paper' })).toBeInTheDocument();
    expect(within(centre()).getByRole('group', { name: 'Search denied: my lecture notes' })).toBeInTheDocument();
    // Not a material citation: the sources row does not count web links.
    expect(within(centre()).queryByRole('button', { name: /source/i })).not.toBeInTheDocument();
  });

  it('long results show the first 5, then «Show N more»', async () => {
    const world = webWorld();
    const many = Array.from({ length: 14 }, (_, i) => ({ title: `Result ${i + 1}`, url: `https://site${i}.example/p`, site: `site${i}.example` }));
    const part = world.chats.find((c) => c.id === 'c21')!.messages[1]!.parts[0] as KbWebSearchPart;
    part.links = many;
    const user = userEvent.setup();
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Clausius — searched/ }));
    await user.click(await within(centre()).findByRole('button', { name: /14 links/ }));
    const web = within(centre()).getByRole('list', { name: 'From the web' });
    expect(within(web).getAllByRole('link')).toHaveLength(5);
    await user.click(within(centre()).getByRole('button', { name: 'Show 9 more' }));
    expect(within(web).getAllByRole('link')).toHaveLength(14);
  });

  it('Add to wiki saves the page through the materials route; a page SKAZ can’t fetch says why, with Retry', async () => {
    const { user, fake } = await openChat(/Clausius — searched/);
    await user.click(await within(centre()).findByRole('button', { name: /2 links/ }));
    const web = within(centre()).getByRole('list', { name: 'From the web' });
    const [first, second] = within(web).getAllByRole('listitem');
    await user.click(within(first!).getByRole('button', { name: 'Add to wiki' }));
    expect(webCalls(fake)).toContainEqual(['POST', '/kb/materials/web', { url: 'https://en.wikipedia.org/wiki/Second_law' }]);
    expect(await within(first!).findByRole('status')).toHaveTextContent('In library');
    await user.click(within(second!).getByRole('button', { name: 'Add to wiki' }));
    expect(await within(web).findByRole('alert')).toHaveTextContent('Save the page as PDF and import it.');
    expect(within(web).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('the agent\'s skaz_web_search call is not repeated in «Looked at»: the search card says it', async () => {
    const world = webWorld();
    const msg = world.chats.find((c) => c.id === 'c21')!.messages[1]!;
    msg.parts = [{ type: 'tool', name: 'skaz_web_search', label: 'Used skaz_web_search' }, ...msg.parts] as typeof msg.parts;
    const user = userEvent.setup();
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Clausius — searched/ }));
    await within(centre()).findByRole('button', { name: /2 links/ });
    expect(within(centre()).queryByText(/Looked at/)).not.toBeInTheDocument();
  });

  it('the header chip shows the grant and revokes it', async () => {
    const { user, fake } = await openChat(/Clausius — searched/);
    const chip = await within(centre()).findByRole('button', { name: /Web search allowed in this chat/ });
    await user.click(chip);
    await user.click(await screen.findByRole('button', { name: 'Stop allowing' }));
    expect(webCalls(fake)).toContainEqual(['DELETE', '/kb/chats/c21/web-search', null]);
    await waitFor(() => expect(within(centre()).queryByRole('button', { name: /Web search allowed in this chat/ })).not.toBeInTheDocument());
  });
});

describe('What the approval card says leaves SKAZ', () => {
  it('names the searcher\'s own refinement: Claude (up to 8 searches), Codex (its searches); others keep the exact-query line', () => {
    expect(searchScopeNote('claude_code')).toBe('Claude may rephrase it for up to 8 searches; nothing else from the chat or your library is sent.');
    expect(searchScopeNote('codex')).toBe('Codex may rephrase it for its searches; nothing else from the chat or your library is sent.');
    expect(searchScopeNote('hermes')).toBe('Only this query is sent — nothing else from the chat or your library.');
  });
});

describe('Web search on the agent card', () => {
  it('says when each query is asked, or why an agent has no web search', () => {
    const { rerender } = render(<WebSearchNote agent={agent('claude_code', 'Claude Code', 'ready', { web_search: { available: true, reason: null } })} />);
    expect(screen.getByRole('note')).toHaveTextContent('Web search: asks you before each query');
    const reason = 'Codex runs its web search on OpenAI’s side without asking SKAZ first.';
    rerender(<WebSearchNote agent={agent('codex', 'Codex', 'ready', { web_search: { available: false, reason } })} />);
    expect(screen.getByRole('note')).toHaveTextContent(`Web search: off. ${reason}`);
    rerender(<WebSearchNote agent={agent('hermes', 'Hermes Agent', 'ready')} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('W-3b: Codex, Hermes and OpenCode search with your approval through a connected searcher', () => {
    const { rerender } = render(<WebSearchNote agent={agent('hermes', 'Hermes Agent', 'ready', { web_search: { available: true, reason: null, through: 'codex' } })} />);
    expect(screen.getByRole('note')).toHaveTextContent(
      'Web search: with your approval — each query is shown to you first, then searched by Codex in a separate run that gets only the query.');
    rerender(<WebSearchNote agent={agent('opencode', 'OpenCode', 'ready', { web_search: { available: true, reason: null, through: 'claude_code' } })} />);
    expect(screen.getByRole('note')).toHaveTextContent('searched by Claude Code in a separate run');
    const reason = 'Web search needs Codex or Claude Code signed in in SKAZ.';
    rerender(<WebSearchNote agent={agent('codex', 'Codex', 'ready', { web_search: { available: false, reason, through: null } })} />);
    expect(screen.getByRole('note')).toHaveTextContent(`Web search: off. ${reason}`);
  });
});
