import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbAnswerBlockPart, KbCitation } from '../../../api/kb/types.gen';
import { renderKb } from '../../test/renderKb';
import { chatWorld } from '../../test/fixtures';
import { chatMessage } from '../../test/fakeKb';
import { blockChips, itemTag, timecode } from './sources';

// P1: ready-made answer blocks — drawn by SKAZ from checked data; one row of source chips under each
// block (R2), no type captions (R1), a placeholder while streaming, a broken block asks for a fix.

const cite = (material_id: string, title: string, seg: number, at: { start_ms?: number; page?: number }): KbCitation => ({
  material_id, seg, available: true, material_title: title, start_ms: at.start_ms ?? null, end_ms: null,
  page: at.page ?? null, quote: null,
});
const LECTURE = { type: 'cite' as const, citation: cite('m1', 'Lecture 8', 1, { start_ms: 2_600_000 }) };
const LECTURE_2 = { type: 'cite' as const, citation: cite('m1', 'Lecture 8', 2, { start_ms: 2_620_000 }) };
const BOOK = { type: 'cite' as const, citation: cite('m2', 'Textbook', 9, { page: 31 }) };
/** Not composed, nothing to copy (P1b fields). */
const PLACE = { beside: false, link: null, markdown: null };
const PAGE = { type: 'page' as const, page: { id: 'p-entropy', kind: 'concept' as const, title: 'Entropy' }, block_id: null, available: true };

const compare: KbAnswerBlockPart = {
  type: 'answer_block', id: 'blk-cmp', state: 'ready', hidden: 1, error: null, raw: null, ...PLACE,
  sources: [LECTURE, BOOK, PAGE],
  block: {
    kind: 'compare', title: null, columns: ['Boltzmann', 'Shannon'],
    rows: [
      { id: 'r1', label: 'Formula', cells: [
        { id: 'r1c1', src: [0], agent: false, text: 'S = k·ln W' },
        { id: 'r1c2', src: [1], agent: false, text: 'H = −Σ p·log p' }] },
      { id: 'r2', label: 'Used in', cells: [
        { id: 'r2c1', src: [], agent: true, text: 'Statistical mechanics' },
        null] },
      { id: 'r3', label: 'Page', cells: [{ id: 'r3c1', src: [2], agent: false, text: 'See the wiki' }, { id: 'r3c2', src: [0], agent: false, text: 'Lecture' }] },
    ],
  },
};
const timeline: KbAnswerBlockPart = {
  type: 'answer_block', id: 'blk-tl', state: 'ready', hidden: 0, error: null, raw: null, ...PLACE,
  sources: [BOOK, LECTURE_2],
  block: { kind: 'timeline', title: 'History', events: [
    { id: 'e1', src: [0], agent: false, when: '1948', title: 'Shannon’s paper', text: null },
    { id: 'e2', src: [1], agent: false, when: null, title: 'Why a logarithm', text: 'The lecturer explains' },
  ] },
};
const steps: KbAnswerBlockPart = {
  type: 'answer_block', id: 'blk-st', state: 'ready', hidden: 0, error: null, raw: null, ...PLACE, sources: [LECTURE],
  block: { kind: 'steps', title: null, steps: [
    { id: 's1', src: [0], agent: false, title: 'Count the microstates', text: 'W' },
    { id: 's2', src: [0], agent: false, title: 'Take the logarithm', text: null },
  ] },
};
const broken: KbAnswerBlockPart = {
  type: 'answer_block', id: 'blk-bad', state: 'broken', block: null, sources: [], hidden: 0, ...PLACE,
  error: 'Unknown block type “mindmap”. Use one of: compare, timeline, steps.', raw: '{"type": "mindmap"}',
};
const drawing: KbAnswerBlockPart = {
  type: 'answer_block', id: 'blk-wait', state: 'drawing', block: null, sources: [], hidden: 0, error: null, raw: null, ...PLACE,
};

async function openAnswer(parts: KbAnswerBlockPart[]) {
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
  return { user, chat, ...r };
}

describe('P1: answer blocks in a chat answer', () => {
  it('compare: a table with one row of source chips, no type caption, the hidden badge only when something is hidden', async () => {
    const { chat } = await openAnswer([compare, steps]);
    const table = within(chat).getByRole('region', { name: 'Comparison' });
    expect(within(table).getByRole('columnheader', { name: 'Boltzmann' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Formula' })).toBeInTheDocument();
    expect(within(table).getByText('S = k·ln W')).toBeInTheDocument();
    expect(within(table).getByLabelText('Hidden')).toHaveTextContent('—');
    // R1: no captions such as «Comparison» or «Steps» are drawn as text.
    expect(within(chat).queryByText('Comparison')).toBeNull();
    expect(within(chat).queryByText('Steps')).toBeNull();
    const row = within(table).getByRole('group', { name: 'Sources of this block' });
    expect(within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open source: Lecture 8', 'Open source: Textbook', 'Open source: Entropy']);
    expect(within(row).getByRole('note', { name: 'Agent’s knowledge: not from your materials' })).toBeInTheDocument();
    expect(within(row).getByRole('note', { name: /^1 item hidden/ })).toHaveTextContent('1');
    // The steps block hides nothing: no badge, and no agent chip.
    const stepsBlock = within(chat).getByRole('region', { name: 'Steps' });
    expect(within(stepsBlock).queryByRole('note')).toBeNull();
    expect(within(stepsBlock).getAllByRole('listitem').map((li) => li.querySelector('b')?.textContent)).toEqual([
      'Count the microstates', 'Take the logarithm']);
  });

  it('hovering an item lights its chip; hovering a chip lights its items; a chip opens its source', async () => {
    const { user, chat } = await openAnswer([compare]);
    const table = within(chat).getByRole('region', { name: 'Comparison' });
    const lecture = within(table).getByRole('button', { name: 'Open source: Lecture 8' });
    const cell = within(table).getByText('S = k·ln W').closest('td')!;
    expect(cell).toHaveTextContent('Lecture 8 · 43:20'); // the label shown above it on hover
    await user.hover(cell);
    expect(lecture).toHaveClass('is-hl');
    expect(within(table).getByRole('button', { name: 'Open source: Textbook' })).not.toHaveClass('is-hl');
    await user.unhover(cell);
    expect(lecture).not.toHaveClass('is-hl');
    await user.hover(lecture);
    const lit = Array.from(table.querySelectorAll('.kb-blk__item.is-hl')).map((el) => el.getAttribute('data-item-id'));
    expect(lit).toEqual(['r1c1', 'r3c2']);
    await user.unhover(lecture);
    await user.hover(within(table).getByRole('note', { name: /Agent’s knowledge/ }));
    expect(Array.from(table.querySelectorAll('.kb-blk__item.is-hl')).map((el) => el.getAttribute('data-item-id'))).toEqual(['r2c1']);
    await user.click(lecture);
    expect(await screen.findByRole('complementary', { name: 'Document' })).toBeInTheDocument();
  });

  it('timeline: dates as they are, a recording moment as its time that opens the recording', async () => {
    const { user, chat } = await openAnswer([timeline]);
    const block = within(chat).getByRole('region', { name: 'Timeline: History' });
    expect(within(block).getByText('History')).toBeInTheDocument(); // the agent's own heading stays
    expect(within(block).getByText('1948')).toBeInTheDocument();
    const tc = within(block).getByRole('button', { name: 'Open the recording at 43:40' });
    expect(tc).toHaveTextContent('43:40');
    await user.click(tc);
    expect(await screen.findByRole('complementary', { name: 'Document' })).toBeInTheDocument();
  });

  it('a block still streaming is a placeholder; a broken one shows its data and asks the agent once', async () => {
    const { user, chat, fake } = await openAnswer([drawing, broken]);
    expect(within(chat).getByRole('status', { name: 'Drawing a block' })).toHaveTextContent('Drawing a block…');
    const bad = within(chat).getByRole('group', { name: 'Block that couldn’t be drawn' });
    expect(bad).toHaveTextContent('This block couldn’t be drawn');
    expect(within(bad).queryByLabelText('Block data')).toBeNull();
    await user.click(within(bad).getByRole('button', { name: 'Show the data' }));
    expect(within(bad).getByLabelText('Block data')).toHaveTextContent('{"type": "mindmap"}');
    expect(bad).toHaveTextContent('Unknown block type “mindmap”');
    const sent = () => fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/chats/c1/messages');
    expect(sent()).toHaveLength(0);
    await user.click(within(bad).getByRole('button', { name: 'Ask the agent to fix' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    const text = (sent()[0]!.body as { text: string }).text;
    expect(text).toContain('```skaz-block');
    expect(text).toContain('{"type": "mindmap"}');
    expect(text).toContain('Reply in English.');
    expect(within(bad).getByRole('button', { name: 'Asked the agent' })).toBeDisabled();
  });

  it('a placeholder is replaced in place when the block arrives (part_update)', async () => {
    const { chat, services } = await openAnswer([drawing]);
    expect(within(chat).getByRole('status', { name: 'Drawing a block' })).toBeInTheDocument();
    const s = services.chats.getState();
    const open = s.chats.c1!.chat!;
    const { applyEvents } = await import('../../state/chats');
    const next = applyEvents(open, [{ seq: open.cursor + 1, type: 'part_update', message_id: 'c1-a2', text: null,
      part: { ...steps, id: 'blk-wait' }, message: null }]);
    act(() => services.chats.setState({ chats: { ...s.chats, c1: { ...s.chats.c1!, chat: next } } }));
    expect(within(chat).queryByRole('status', { name: 'Drawing a block' })).toBeNull();
    expect(within(chat).getByRole('region', { name: 'Steps' })).toHaveAttribute('data-block-id', 'blk-wait');
  });
});

describe('P1: block sources', () => {
  it('segments of one material share one chip; the agent chip comes last; labels carry the time or page', () => {
    const items = [{ id: 'a', src: [1], agent: false }, { id: 'b', src: [], agent: true }, { id: 'c', src: [0, 2], agent: false }];
    const chips = blockChips([LECTURE, BOOK, LECTURE_2], items);
    expect(chips.map((c) => [c.key, c.label, c.icon])).toEqual([
      ['m:m2', 'Textbook', 'pdf'], ['m:m1', 'Lecture 8', 'play'], ['agent', 'Agent’s knowledge', 'agent']]);
    expect(itemTag(items[2]!, [LECTURE, BOOK, LECTURE_2]).text).toBe('Lecture 8 · 43:20');
    expect(itemTag(items[0]!, [LECTURE, BOOK]).text).toBe('Textbook · p. 31');
    expect(itemTag(items[1]!, []).agent).toBe(true);
    expect(timecode({ id: 'x', src: [0], agent: false }, [BOOK])).toBeNull();
    expect(timecode({ id: 'x', src: [0], agent: false }, [LECTURE])?.ms).toBe(2_600_000);
  });
});
