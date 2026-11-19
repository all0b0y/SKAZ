// G1 (SKAZ 0.4.1, 09-HEADING-ACCENTS.md and the approved heading-accents-selected.html): where the
// accepted marks land in production, and what stays plain. `@` before the open Material/Wiki
// document title, `//` before the main headings of a chat answer, one star before the Notes title
// and the main Wiki/Notes sections. The contract under test is the one the decisions demand: the
// mark is ink, never text — accessible names, section toggles, quotes, the chat find walk and
// copies keep exactly the heading's own words — and no surface outside these headings (menus,
// side lists, small headings, transcript fragments, wiki blocks and files) is decorated.
// DOM truth in jsdom; the painted look (baseline, sizes, accents, themes, widths) is the
// native/live visual pass recorded with the coordinator.
import { describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbChat } from '../../../api/kb/types.gen';
import { renderKb } from '../../test/renderKb';
import { chatWorld, docWorld } from '../../test/fixtures';
import { chatMessage } from '../../test/fakeKb';
import { InlineMarkdown } from '../../chat/Markdown';
import { plainText } from '../../chat/Message';
import { AnswerMarkdown } from '../../ui/AnswerMarkdown';
import { headingLineClass } from './headingAccents';

/** Every text node under `root` — the words a selection, a copy or the chat find walk can reach. */
function textNodes(root: Element): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node.textContent ?? '');
  return out;
}

/** A chat whose answer lays out its reply in Markdown headings, like the approved mock. */
const REPLY = [
  'Two different questions: what happens on a failure, and what parallel transactions see.',
  '# Atomicity and rollback',
  'A transaction applies every change or none of them.',
  '## Example',
  'If the second write fails, the first is not kept either.',
].join('\n\n');

function headingChatWorld() {
  const world = chatWorld();
  const at = new Date(Date.now() - 30 * 60_000).toISOString();
  const chat: KbChat = {
    id: 'c-ham', title: 'Transaction steps', pinned: false, engine: 'claude_code', model: 'claude-opus-5-5',
    effort: 'medium', created_at: at, updated_at: at, last_preview: '', recording_material_id: null,
    folder_ids: [], state: 'idle', unread: false, cursor: 0,
    messages: [
      chatMessage('ham-q', 1, 'user', at, [{ type: 'text', text: 'Lay out atomicity and isolation step by step.' }]),
      chatMessage('ham-a', 2, 'assistant', at, [{ type: 'text', text: REPLY }]),
    ],
  };
  world.chats.push(chat);
  return world;
}

/** An answer the agent stopped mid-heading: the streamed opener `#` is the last token that arrived. */
const STOPPED_REPLY = [
  '# Atomicity and rollback',
  'A transaction applies every change or none of them.',
  '#',
].join('\n\n');

function stoppedChatWorld(opener: string) {
  const world = chatWorld();
  const at = new Date(Date.now() - 30 * 60_000).toISOString();
  const chat: KbChat = {
    id: 'c-ham-stop', title: 'Stopped mid-heading', pinned: false, engine: 'claude_code', model: 'claude-opus-5-5',
    effort: 'medium', created_at: at, updated_at: at, last_preview: '', recording_material_id: null,
    folder_ids: [], state: 'idle', unread: false, cursor: 0,
    messages: [
      chatMessage('ham-q', 1, 'user', at, [{ type: 'text', text: 'Lay out atomicity and isolation step by step.' }]),
      chatMessage('ham-a', 2, 'assistant', at, [{ type: 'text', text: STOPPED_REPLY.slice(0, -1) + opener }], { state: 'cancelled' }),
    ],
  };
  world.chats.push(chat);
  return world;
}

/** The right panel with a document open, the way page.test.tsx opens one. */
async function openDocument(id: string, type: 'page' | 'material' = 'page') {
  const r = renderKb({ world: docWorld() });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type, id }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  return { ...r, doc };
}

describe('G1: the open document titles (Wiki, Notes, Material)', () => {
  it('a wiki page opens with `@` before its title, one star before each main section, only the words', async () => {
    const user = userEvent.setup();
    const { doc } = await openDocument('p-entropy');
    // The title keeps exactly its own words — in the accessible name and in the DOM's text nodes.
    const title = await within(doc).findByRole('heading', { level: 2, name: 'Entropy' });
    const titleMark = title.querySelector<HTMLElement>('.kb-ham');
    expect(titleMark?.getAttribute('data-ham')).toBe('at');
    expect(titleMark?.className).toContain('kb-ham--title');
    expect(titleMark?.getAttribute('aria-hidden')).toBe('true');
    expect(title).toHaveClass(headingLineClass);
    expect(textNodes(title)).toEqual(['Entropy']);

    // Every main section toggle carries one star before its title.
    const sections = doc.querySelectorAll('.kb-psec__toggle');
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      const mark = section.querySelector<HTMLElement>('.kb-ham');
      expect(mark?.getAttribute('data-ham')).toBe('star');
      expect(mark?.className).not.toContain('kb-ham--title');
      expect(textNodes(mark!)).toEqual([]);
    }
    // Collapsing a section is unchanged: the star stays, the body hides.
    const toggle = within(doc).getByRole('button', { name: 'In brief' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.querySelector('.kb-ham')?.getAttribute('data-ham')).toBe('star');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Small footer headings stay plain, and no mark lives outside the document panel
    // (menus, the side list, the rail, chips and buttons are not decorated).
    for (const name of ['Related', 'Mentioned in']) {
      expect(within(doc).getByRole('heading', { name }).querySelector('.kb-ham')).toBeNull();
    }
    for (const mark of document.querySelectorAll('.kb-ham')) expect(doc.contains(mark)).toBe(true);
  });

  it('a Notes page keeps the star: its title and its main sections', async () => {
    const { doc } = await openDocument('p-note8');
    const title = await within(doc).findByRole('heading', { level: 2, name: 'Notes: Lecture 8 — entropy' });
    expect(title.querySelector('.kb-ham')?.getAttribute('data-ham')).toBe('star');
    expect(title.querySelector('.kb-ham')?.className).toContain('kb-ham--title');
    expect(textNodes(title)).toEqual(['Notes: Lecture 8 — entropy']);
    const sections = doc.querySelectorAll('.kb-psec__toggle');
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.querySelector('.kb-ham')?.getAttribute('data-ham')).toBe('star');
    }
  });

  it('an open material carries exactly one `@` at its title; fragments, chips and controls stay plain', async () => {
    const { doc } = await openDocument('m-lec8', 'material');
    const title = await within(doc).findByRole('heading', { level: 2, name: 'Lecture 8 — entropy' });
    expect(title.querySelector('.kb-ham')?.getAttribute('data-ham')).toBe('at');
    expect(title.querySelector('.kb-ham')?.className).toContain('kb-ham--title');
    expect(textNodes(title)).toEqual(['Lecture 8 — entropy']);
    // The transcript below may hold its own headings; they are content, not reply headings.
    expect(doc.querySelectorAll('.kb-ham')).toHaveLength(1);
  });
});

describe('G1: the main headings of a chat answer', () => {
  it('`//` before each main heading, small headings plain, the words alone in names, selection and copy', async () => {
    const user = userEvent.setup();
    renderKb({ world: headingChatWorld() });
    await user.click(await screen.findByRole('button', { name: /Transaction steps/ }));
    const main = await screen.findByRole('heading', { level: 3, name: 'Atomicity and rollback' });
    const mark = main.querySelector<HTMLElement>('.kb-ham');
    expect(mark?.getAttribute('data-ham')).toBe('slashes');
    expect(mark?.className).not.toContain('kb-ham--title');
    expect(main).toHaveClass(headingLineClass);
    expect(textNodes(main)).toEqual(['Atomicity and rollback']);
    // The smaller heading of the answer stays plain.
    expect(screen.getByRole('heading', { level: 4, name: 'Example' }).querySelector('.kb-ham')).toBeNull();
    // Everything a user can select, find or copy in the answer is words only.
    const answer = screen.getByRole('article', { name: 'Answer' });
    expect(textNodes(answer).join('')).not.toMatch(/@|\*|\//);
    // Copy takes the source parts, which no mark ever touched.
    expect(plainText([{ type: 'text', text: REPLY }])).toBe(REPLY.trim());
    // Marks never wander out of the answer's headings.
    for (const el of document.querySelectorAll('.kb-ham')) {
      expect(el.closest('article')?.getAttribute('aria-label')).toBe('Answer');
    }
  });

  it.each(['#', '# ##'])('an answer stopped at %j keeps no empty heading or stand-alone `//`', async (opener) => {
    const user = userEvent.setup();
    renderKb({ world: stoppedChatWorld(opener) });
    await user.click(await screen.findByRole('button', { name: /Stopped mid-heading/ }));
    // The stop is settled in the conversation, so the incomplete opener is its final state.
    expect(await screen.findByText('Stopped. The question is kept — you can regenerate the answer.'))
      .toBeInTheDocument();
    const answer = screen.getByRole('article', { name: 'Answer' });
    const main = within(answer).getByRole('heading', { level: 3, name: 'Atomicity and rollback' });
    // The populated main heading before the stop keeps the accepted decoration and its own words.
    expect(main.querySelector('.kb-ham')?.getAttribute('data-ham')).toBe('slashes');
    expect(main.textContent).toBe('Atomicity and rollback');
    // The bare opener the answer stopped at has no heading words (or empty heading to navigate to).
    expect(within(answer).queryAllByRole('heading')).toHaveLength(1);
    expect(answer.querySelectorAll('.kb-ham')).toHaveLength(1);
    await user.click(within(answer).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(STOPPED_REPLY.slice(0, -1) + opener);
  });
});

describe('G1: the shared Markdown renderer decorates only a host that opts in', () => {
  it('wiki text (blocks, index and log files) keeps its plain headings', () => {
    const content = '# Only words\n\nA block of a wiki page.';
    const { container } = render(
      <AnswerMarkdown content={content} citations={[]} activeSessionId={null} onCite={() => undefined} />,
    );
    expect(container.querySelector('h3')?.textContent).toBe('Only words');
    expect(container.querySelector('p')?.textContent).toBe('A block of a wiki page.');
    expect(container.querySelector('.kb-ham')).toBeNull();
  });

  it('the chat reply host opts in: its main heading opens with `//`, deeper levels are untouched', () => {
    const pieces: Array<string | number> = ['# Only words\n\n## Small\n\nBody.'];
    const { container } = render(<InlineMarkdown pieces={pieces} slot={() => null} />);
    const heads = [...container.querySelectorAll('h3, h4')] as [HTMLElement, HTMLElement];
    const [main, small] = heads;
    expect(main.querySelector('.kb-ham')?.getAttribute('data-ham')).toBe('slashes');
    expect(main.textContent).toBe('Only words');
    expect(small.querySelector('.kb-ham')).toBeNull();
  });
});
