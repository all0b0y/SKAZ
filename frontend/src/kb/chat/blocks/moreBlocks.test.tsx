import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbAnswerBlockPart, KbCitation, KbMessagePart } from '../../../api/kb/types.gen';
import { renderKb } from '../../test/renderKb';
import { chatWorld } from '../../test/fixtures';
import { chatMessage } from '../../test/fakeKb';
import { answerCitations, plainText } from '../Message';
import { initials } from './ActionItems';
import { hierarchyTree } from './Hierarchy';
import { rendererOf } from './registry';
import type { BlockData } from './sources';

// P1b: the other twelve blocks, Copy as Markdown, the answer's sources.

const cite = (material_id: string, title: string, seg: number, at: { start_ms?: number; page?: number }): KbCitation => ({
  material_id, seg, available: true, material_title: title, start_ms: at.start_ms ?? null, end_ms: null,
  page: at.page ?? null, quote: null,
});
const LECTURE = { type: 'cite' as const, citation: cite('m1', 'Lecture 8', 1, { start_ms: 2_600_000 }) };
const BOOK = { type: 'cite' as const, citation: cite('m2', 'Textbook', 9, { page: 31 }) };
const it0 = (id: string) => ({ id, src: [0], agent: false });
const agent = (id: string) => ({ id, src: [], agent: true });

const part = (id: string, block: BlockData, extra: Partial<KbAnswerBlockPart> = {}): KbAnswerBlockPart => ({
  type: 'answer_block', id, state: 'ready', block, sources: [LECTURE, BOOK], hidden: 0, error: null, raw: null,
  beside: false, link: null, markdown: `md of ${id}`, ...extra,
});

const BLOCKS: BlockData[] = [
  { kind: 'pros_cons', title: 'Raft', pros: [{ ...it0('p1'), text: 'Simple' }], cons: [{ ...agent('c1'), text: 'Slow writes' }] },
  { kind: 'verdict', title: null, verdict: { ...it0('v'), text: 'Choose Raft', reason: 'It is simpler' } },
  { kind: 'cause_chain', title: null, nodes: [{ ...it0('n1'), label: 'Cause', text: 'Hard to read' }, { ...it0('n2'), label: null, text: 'Bugs' }] },
  { kind: 'definition', title: null, term: 'Term', also: ['epoch', 'era'], definition: { ...it0('def'), text: 'A logical clock' },
    example: { ...it0('ex'), text: 'Term 5 ignores term 4' } },
  { kind: 'concept_cards', title: null, cards: [{ ...it0('k1'), name: 'Quorum', text: 'A majority' }] },
  { kind: 'hierarchy', title: null, nodes: [
    { ...it0('n1'), text: 'Consensus', note: null, depth: 0 }, { ...agent('n1-1'), text: 'With a leader', note: null, depth: 1 },
    { ...it0('n1-1-1'), text: 'Raft', note: 'popular', depth: 2 }, { ...it0('n1-2'), text: 'Leaderless', note: null, depth: 1 }] },
  { kind: 'glossary', title: null, terms: [{ ...it0('g1'), term: 'Follower', text: 'A passive node' }] },
  { kind: 'key_numbers', title: null, numbers: [{ ...it0('k1'), value: '150–300', unit: 'ms', label: 'Election timeout' }] },
  { kind: 'chart', title: 'Latency', unit: 'ms', alt_label: 'No stable leader', bars: [
    { ...it0('b1'), label: 'Paxos', value: 8, display: '8', alt: true }, { ...it0('b2'), label: 'Raft', value: 4, display: '4', alt: false }] },
  { kind: 'quote', title: null, quote: { ...it0('q'), text: 'The timeout is the trick.', who: 'The lecturer' } },
  { kind: 'disagreement', title: 'Leader?', sides: [{ ...it0('d1'), text: 'No leader' }, { id: 'd2', src: [1], agent: false, text: 'A proposer' }],
    agree: { ...agent('agree'), text: 'Safety needs none' } },
  { kind: 'action_items', title: null, tasks: [
    { ...it0('t1'), task: 'Implement it', owner: 'Anna Kim', owner_is_you: false, due: 'by 3 November' },
    { ...it0('t2'), task: 'Read the paper', owner: null, owner_is_you: true, due: null },
    { ...it0('t3'), task: 'Write a test', owner: null, owner_is_you: false, due: null }] },
];

async function openAnswer(parts: KbMessagePart[]) {
  const user = userEvent.setup();
  const world = chatWorld();
  const c1 = world.chats.find((c) => c.id === 'c1')!;
  c1.messages.push(chatMessage('c1-a2', 3, 'assistant', new Date().toISOString(),
    [{ type: 'text', text: 'In short:\n' }, ...parts, { type: 'text', text: 'That is all.' }]));
  c1.cursor = 3;
  renderKb({ world });
  await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
  const chat = screen.getByRole('region', { name: 'Chat' });
  await within(chat).findByText('That is all.');
  return { user, chat };
}

describe('P1b: the twelve other blocks', () => {
  it('each is drawn without a type caption, and every item carries its id for selection (P2)', async () => {
    const { chat } = await openAnswer(BLOCKS.map((block, i) => part(`blk-${i}`, block)));
    for (const [i, block] of BLOCKS.entries()) {
      const renderer = rendererOf(block);
      const region = chat.querySelector(`[data-block-id="blk-${i}"]`) as HTMLElement;
      expect(region).toHaveAttribute('data-kind', block.kind);
      expect(region).toHaveAccessibleName(block.title ? `${renderer.name}: ${block.title}` : renderer.name);
      const drawn = Array.from(region.querySelectorAll('[data-item-id]')).map((el) => el.getAttribute('data-item-id'));
      expect(drawn).toEqual(renderer.items(block).map((item) => item.id));
      expect(within(region).queryByText(renderer.name)).toBeNull(); // R1
    }
  });

  it('marks, numbers and words carry the meaning, not colour alone', async () => {
    const { chat } = await openAnswer(BLOCKS.map((block, i) => part(`blk-${i}`, block)));
    const pc = within(chat).getByRole('region', { name: 'Pros and cons: Raft' });
    expect(within(pc).getByRole('img', { name: 'For' }).closest('li')).toHaveTextContent('Simple');
    expect(within(pc).getByRole('img', { name: 'Against' }).closest('li')).toHaveTextContent('Slow writes');
    const def = within(chat).getByRole('region', { name: 'Definition' });
    expect(def.querySelector('dfn')).toHaveTextContent('Term');
    expect(def).toHaveTextContent('epoch · era');
    expect(def).toHaveTextContent('ExampleTerm 5 ignores term 4');
    const chart = within(chat).getByRole('region', { name: 'Chart: Latency' });
    const fills = Array.from(chart.querySelectorAll<HTMLElement>('.kb-blk-chart__fill')).map((el) => [el.style.width, el.className]);
    expect(fills).toEqual([['100%', 'kb-blk-chart__fill kb-blk-chart__fill--alt'], ['50%', 'kb-blk-chart__fill']]);
    expect(chart).toHaveTextContent('8 ms');
    expect(chart).toHaveTextContent('Hatched: No stable leader');
    const dis = within(chat).getByRole('region', { name: 'Sources disagree: Leader?' });
    const sides = Array.from(dis.querySelectorAll('.kb-blk-dis__src')).map((el) => el.textContent);
    expect(sides).toEqual(['Lecture 8 · 43:20', 'Textbook · p. 31']); // who says it: the side's source
    expect(dis).toHaveTextContent('They agree: Safety needs none');
    const tasks = within(chat).getByRole('region', { name: 'Action items' });
    const metas = Array.from(tasks.querySelectorAll('.kb-blk-ai__meta')).map((el) => el.textContent);
    expect(metas).toEqual(['AKAnna Kimby 3 November', 'YouNo due date', 'Owner not namedNo due date']);
    const tree = within(chat).getByRole('region', { name: 'Hierarchy' });
    const raft = within(tree).getByText('Raft').closest('li')!;
    expect(raft.parentElement!.closest('li')).toHaveTextContent(/^With a leader/);
    expect(within(chat).getByRole('region', { name: 'Quote' }).querySelector('blockquote')).toHaveTextContent('The timeout is the trick.');
  });

  it('the hierarchy is rebuilt from its flat reading order; initials are the first letters', () => {
    const block = BLOCKS[5] as Extract<BlockData, { kind: 'hierarchy' }>;
    const tree = hierarchyTree(block.nodes);
    expect(tree.map((t) => [t.node.id, t.children.map((c) => [c.node.id, c.children.map((g) => g.node.id)])])).toEqual([
      ['n1', [['n1-1', ['n1-1-1']], ['n1-2', []]]]]);
    expect(initials('Anna Kim')).toBe('AK');
    expect(initials(' ёлка ')).toBe('Ё');
  });
});

describe('P1b: Copy as Markdown and the answer', () => {
  it('Copy sits in the sources row and copies the block’s Markdown; a broken block has none', async () => {
    const broken: KbAnswerBlockPart = { ...part('blk-bad', BLOCKS[0]!), state: 'broken', block: null, markdown: null,
      error: 'Invalid block data', raw: '{}' };
    const { user, chat } = await openAnswer([part('blk-q', BLOCKS[9]!, { markdown: '> The timeout is the trick. [Lecture 8 · 43:20]' }), broken]);
    const quote = within(chat).getByRole('region', { name: 'Quote' });
    const row = within(quote).getByRole('group', { name: 'Sources of this block' });
    const copy = within(row).getByRole('button', { name: 'Copy as Markdown' });
    expect(row.lastElementChild).toContainElement(copy); // R1: bottom right
    expect(copy).toHaveClass('kb-blk__copy');
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe('> The timeout is the trick. [Lecture 8 · 43:20]');
    expect(within(row).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    const bad = within(chat).getByRole('group', { name: 'Block that couldn’t be drawn' });
    expect(within(bad).queryByRole('button', { name: /Copy/ })).toBeNull();
    expect(within(bad).getByRole('button', { name: 'Ask the agent to fix' })).toBeInTheDocument();
  });

  it('the answer’s Sources count and its Copy include what only blocks cite', () => {
    const parts: KbMessagePart[] = [
      { type: 'text', text: 'Intro ' }, { type: 'cite', citation: LECTURE.citation },
      part('blk-1', BLOCKS[1]!, { markdown: '**Verdict:** Choose Raft [Textbook · p. 31]' }),
      { type: 'text', text: 'End.' },
    ];
    expect(answerCitations(parts as never).map((c) => c.material_id)).toEqual(['m1', 'm1', 'm2']);
    expect(plainText(parts as never)).toBe('Intro Lecture 8\n\n**Verdict:** Choose Raft [Textbook · p. 31]\n\nEnd.');
  });

  it('a block cited only from a block shows in «Sources · N»', async () => {
    const { chat } = await openAnswer([part('blk-1', BLOCKS[1]!, { sources: [BOOK], block: { ...BLOCKS[1]!, verdict: { id: 'v', src: [0], agent: false, text: 'x', reason: null } } as BlockData })]);
    const article = within(chat).getAllByRole('article', { name: 'Answer' }).at(-1)!;
    expect(within(article).getByRole('button', { name: /^Sources · 1/ })).toBeInTheDocument();
  });
});
