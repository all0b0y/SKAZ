import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbChat, KbMessage, KbStudyPart, KbWebSearchPart } from '../../api/kb/types.gen';
import { chatMessage, type FakeWorld } from '../test/fakeKb';
import { ago, chatWorld, deckPart } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import { chatOverview, linksIn } from './model';

// N8 · Chat overview: Links (dedup by address; from search per query with «used in answer»; in
// messages by you / by agent; filtered ones only counted) · Used (cited with counts, looked at, added
// by you; exclude from this chat) · Created (study; wiki analysis and «Fix in wiki» before → after).

const cite = (id: string, title: string, seg: number) => ({ type: 'cite' as const, citation: { material_id: id, seg, available: true, material_title: title, start_ms: null, end_ms: null, page: null } });
const search: KbWebSearchPart = {
  type: 'web_search', id: 'web-1', engine: 'codex', searcher: 'codex', query: 'wiki trustworthiness staleness', allowed_domains: [], blocked_domains: [],
  status: 'allowed', auto: false, reason: null, rules: null,
  links: [
    { title: 'Keeping a large wiki trustworthy', url: 'https://arxiv.org/abs/1', site: 'arxiv.org' },
    { title: 'Claim-level provenance', url: 'https://semanticscholar.org/p/2', site: 'semanticscholar.org' },
  ],
  hidden: [{ site: 'pinterest.com', count: 2 }, { site: 'medium.com', count: 1 }],
};
const deck: KbStudyPart = deckPart('st-1', 'c40', 'a1', { title: 'Spaced repetition', save: { status: 'saved', path: 'x', page_id: 'p-d' } });

function messages(): KbMessage[] {
  return [
    chatMessage('u1', 1, 'user', ago(10), [{ type: 'text', text: 'How to keep a wiki trustworthy? See https://github.com/karpathy/notes.' }],
      { input: { text: 'How to keep a wiki trustworthy? See https://github.com/karpathy/notes.', mentions: [{ type: 'material', id: 'm2', title: 'Textbook: Information theory, ch. 2' }], quotes: [], attachments: [] } }),
    chatMessage('a1', 2, 'assistant', ago(9), [
      search,
      { type: 'text', text: 'Check claims, not pages ([paper](https://arxiv.org/abs/1)). More: [FSRS explained](https://expertium.github.io/fsrs).' },
      cite('m1', 'Lecture 8 — entropy', 2), cite('m1', 'Lecture 8 — entropy', 3), cite('m2', 'Textbook: Information theory, ch. 2', 9),
      { type: 'page', page: { id: 'p-entropy', kind: 'concept', title: 'Entropy' }, block_id: null },
      { type: 'tool', name: 'skaz_read_material', label: 'Read Lecture 5 — classifiers', target: { type: 'material', id: 'm5' } },
      { type: 'tool', name: 'skaz_read_material', label: 'Read Lecture 8 — entropy', target: { type: 'material', id: 'm1' } },
      deck,
      { type: 'wiki_fix', id: 'fx-1', page: { id: 'p-entropy', kind: 'concept', title: 'Entropy' }, block_id: 'b1', before: 'disorder', after: 'number of microstates', reason: 'r', status: 'applied', available: true },
    ], { saved_page_id: 'p-analysis' }),
    chatMessage('u2', 3, 'user', ago(8), [{ type: 'text', text: 'Again https://arxiv.org/abs/1' }]),
  ];
}

describe('chat overview model', () => {
  it('reads markdown and bare links', () => {
    expect(linksIn('a [T](https://x.org/a) and https://y.org/b.')).toEqual([
      { url: 'https://x.org/a', title: 'T' }, { url: 'https://y.org/b', title: 'y.org' }]);
  });

  it('links: each address once; search links per query with «used in answer»; filtered only counted', () => {
    const data = chatOverview(messages());
    expect(data.searches).toEqual([expect.objectContaining({ query: 'wiki trustworthiness staleness', hidden: 3 })]);
    expect(data.searches[0]!.links.map((l) => [l.site, l.used])).toEqual([['arxiv.org', true], ['semanticscholar.org', false]]);
    expect(data.inMessages.map((l) => [l.site, l.by, l.messageId])).toEqual([
      ['github.com', 'you', 'u1'], ['expertium.github.io', 'agent', 'a1']]);
    expect(data.links).toBe(4);
    expect(data.hidden).toBe(3);
  });

  it('used: cited with counts and the first message; looked at; added by you', () => {
    const data = chatOverview(messages());
    expect(data.cited.map((i) => [i.kind, i.id, i.count, i.byYou, i.messageId])).toEqual([
      ['material', 'm1', 2, false, 'a1'], ['material', 'm2', 1, true, 'a1'], ['page', 'p-entropy', 1, false, 'a1']]);
    expect(data.lookedAt.map((i) => [i.id, i.title])).toEqual([['m5', 'Lecture 5 — classifiers']]);
  });

  it('created: study blocks and the wiki (analysis page, applied fixes with before → after)', () => {
    const data = chatOverview(messages());
    expect(data.study).toEqual([{ id: 'st-1', kind: 'deck', title: 'Spaced repetition', saved: true, messageId: 'a1' }]);
    expect(data.wiki.map((w) => [w.kind, w.title, w.before ?? null, w.after ?? null])).toEqual([
      ['analysis', 'How to keep a wiki trustworthy? See https://github.com/karpathy/notes.', null, null],
      ['fix', 'Entropy', 'disorder', 'number of microstates']]);
  });
});

function world(): FakeWorld {
  const w = chatWorld();
  const chat: KbChat = {
    id: 'c40', title: 'Wiki trust overview', pinned: false, engine: 'codex', model: 'gpt', effort: 'medium', created_at: ago(20), updated_at: ago(8),
    last_preview: '', recording_material_id: null, folder_ids: [], state: 'idle', unread: false, cursor: 0, messages: messages(),
  };
  w.chats.push(chat);
  w.chatEvents.c40 = [];
  return w;
}

describe('Chat overview in the right panel (N8)', () => {
  it('opens from the chat header with Links · Used · Created; Exclude from this chat goes to the chat’s sources', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: world() });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Wiki trust overview/ }));
    await user.click(await screen.findByRole('button', { name: 'Chat overview' }));
    const panel = await screen.findByRole('region', { name: 'Chat overview' });
    expect(panel).toHaveTextContent('Sources as in Settings');
    const tabs = within(panel).getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Links4', 'Used4', 'Created3']);
    const search = within(panel).getByRole('region', { name: 'From search «wiki trustworthiness staleness»' });
    expect(search).toHaveTextContent('Keeping a large wiki trustworthy· arxiv.org');
    expect(search).toHaveTextContent('used in answer');
    expect(search).toHaveTextContent('3 links hidden by your rules');
    expect(within(panel).getByRole('region', { name: 'In messages' })).toHaveTextContent('by you');

    await user.click(within(panel).getByRole('tab', { name: /Used/ }));
    const cited = within(panel).getByRole('region', { name: 'Cited' });
    expect(cited).toHaveTextContent('Lecture 8 — entropy· 2 citations');
    expect(cited).toHaveTextContent('added by you');
    expect(within(panel).getByRole('region', { name: 'Looked at' })).toHaveTextContent('Lecture 5 — classifiers');
    const row = within(cited).getByText('Lecture 8 — entropy').closest('li')!;
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Exclude from this chat' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/chats/c40/search-rules', body: expect.objectContaining({ excluded: ['m1'] }),
    })));
    await waitFor(() => expect(panel).toHaveTextContent('All sources · 1 excluded'));
    expect(await within(row as HTMLElement).findByRole('button', { name: 'Bring back' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('tab', { name: /Created/ }));
    expect(within(panel).getByRole('region', { name: 'Study' })).toHaveTextContent('Deck · Spaced repetitionsaved to wiki');
    expect(within(panel).getByRole('region', { name: 'Wiki' })).toHaveTextContent('disorder → number of microstates');

    // The header button closes it again.
    await user.click(screen.getByRole('button', { name: 'Close the chat overview' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Chat overview' })).toBeNull());
  });
});
