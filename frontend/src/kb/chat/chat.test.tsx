import { describe, expect, it, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { InlineMarkdown } from './Markdown';
import { AnswerMarkdown } from '../ui/AnswerMarkdown';
import { plainText, toBlocks } from './Message';
import { openTarget } from '../state/document';
import { forgetInChat } from '../state/chats';

/** Freeze the clock at 14:00 today (only Date; timers stay real). */
function atMidday() {
  const noon = new Date();
  noon.setHours(14, 0, 0, 0);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(noon);
}
afterEach(() => { vi.useRealTimers(); });

const side = () => screen.getByRole('region', { name: 'Chats' });

describe('Chats in the side panel', () => {
  it('pinned first, then by date, a few only, "All chats · N"; answering and new-answer marks are still', async () => {
    atMidday(); // day groups (Today / Yesterday) must not depend on when the suite runs
    renderKb({ world: chatWorld() });
    const panel = side();
    const pinned = await within(panel).findByRole('region', { name: 'Pinned' });
    expect(within(pinned).getAllByRole('button').map((b) => b.textContent)).toEqual(['Exam preparation for ML', 'Entropy across folders']);
    const today = within(panel).getByRole('region', { name: 'Today' });
    expect(within(today).getByRole('button', { name: /What did I miss in lecture 8/ })).toBeInTheDocument();
    expect(within(today).getByRole('img', { name: 'answering' })).toBeInTheDocument();
    expect(within(today).getByRole('img', { name: 'new answer' })).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Yesterday' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'All chats · 7' })).toBeInTheDocument();
    // No blinking: the marks have no animation class.
    expect(panel.querySelector('.kb-chatmark--answering')?.className).not.toMatch(/pulse|blink/);
  });

  it('opens a chat: the answer with page and source chips, the connection folded, the tool trail folded', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    expect(await within(centre).findByRole('heading', { name: 'Why is there a logarithm in the loss?' })).toBeInTheDocument();
    const answer = await within(centre).findByRole('article', { name: 'Answer' });
    expect(within(answer).getByText('Shannon entropy').tagName).toBe('STRONG');
    // Page chips are shapes with an icon and a label, not colour only.
    await user.click(within(answer).getAllByRole('button', { name: 'Wiki page: Entropy' })[0]!);
    expect(openTarget(services.ui.getState())).toMatchObject({ type: 'page', id: 'p-entropy' });
    // A source is a footnote number (v42 A); its popup opens the material at the quote.
    expect(within(answer).queryByRole('button', { name: /^Recording: / })).not.toBeInTheDocument();
    await user.click(within(answer).getAllByRole('button', { name: 'Source 1: Lecture 5' })[0]!);
    const pop = await screen.findByRole('dialog', { name: 'Lecture 5' });
    expect(within(pop).getByText('44:00')).toBeInTheDocument();
    await user.click(within(pop).getByRole('button', { name: /^Open at fragment/ }));
    expect(openTarget(services.ui.getState())).toMatchObject({ type: 'material', id: 'm5', seg: 3 });
    // The answer ends with its sources, each once, numbered in order of appearance (connection included).
    const sources = within(answer).getByRole('group', { name: 'Sources' });
    expect(within(sources).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Source 1: Lecture 5', 'Source 2: Lecture 8', 'Source 3: Textbook: Information theory, ch. 2']);
    expect(screen.getByRole('complementary', { name: 'Document' })).toBeInTheDocument();

    const pill = within(answer).getByRole('button', { name: /Connection · 3 folders/ });
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    await user.click(pill);
    const rows = within(answer).getByRole('list', { name: 'Connection across folders' });
    expect(within(rows).getByText('S = k·ln W')).toBeInTheDocument();
    // Connection rows use the answer's numbers: Lecture 5 is 1 here as in the text.
    expect(within(rows).getAllByRole('button', { name: /^Source / }).map((b) => b.textContent)).toEqual(['2', '3', '1']);
    expect(within(rows).getByText('Agent inference:')).toBeInTheDocument();
    expect(within(answer).getByRole('button', { name: /Looked at 1 thing/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('sends a question in a new chat; the answer arrives and the list moves it to the top', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    await within(side()).findByRole('region', { name: 'Pinned' });
    const input = screen.getByTestId('message-input');
    await user.click(input);
    await user.keyboard('What is entropy?');
    await user.keyboard('{Enter}');
    const centre = screen.getByRole('region', { name: 'Chat' });
    expect(await within(centre).findByRole('article', { name: 'Your question' })).toHaveTextContent('What is entropy?');
    await waitFor(() => expect(within(centre).getByRole('article', { name: 'Answer' })).toHaveTextContent('Cross-entropy is Shannon entropy'));
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/chats')).toBe(true);
    const sent = fake.calls.find((c) => c.method === 'POST' && /\/messages$/.test(c.path));
    expect(sent?.body).toMatchObject({ text: 'What is entropy?', mentions: [], quotes: [], attachments: [] });
    expect(input).toHaveTextContent('');
  });

  it('an interrupted answer says why and when, and Resume starts it again', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    await within(side()).findByRole('region', { name: 'Pinned' });
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('hit the limit{Enter}');
    const alert = await screen.findByText('Answer interrupted: subscription limit');
    const card = alert.closest('.kb-interrupt') as HTMLElement;
    expect(card).toHaveTextContent('ChatGPT subscription limit reached.');
    expect(card).toHaveTextContent(/The limit resets/);
    await user.click(within(card).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(fake.calls.some((c) => /\/resume$/.test(c.path))).toBe(true));
  });

  it('⋯ menu: export goes through the native save dialog; save to wiki opens the analysis page; delete asks first', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const more = await within(centre).findByRole('button', { name: /More for/ });
    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Export as .md' }));
    await waitFor(() => expect(fake.bridge.saveTextFile).toHaveBeenCalledWith(expect.objectContaining({ suggested_name: 'Why is there a logarithm in the loss?.md' })));
    expect(await within(centre).findByRole('status')).toHaveTextContent('Exported to /Users/me/Downloads/');

    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Save to wiki as analysis' }));
    await waitFor(() => expect(openTarget(services.ui.getState())).toMatchObject({ type: 'page', id: 'p-c1' }));

    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(within(side()).queryByRole('button', { name: /Why is there a logarithm/ })).not.toBeInTheDocument());
  });

  it('a taken analysis name: the reason is shown and nothing opens (no date appended by the backend)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const taken = 'A wiki page named “Why is there a logarithm in the loss” already exists. Rename the chat or that page, then save again.';
    world.failures['POST /kb/chats/c1/messages/c1-a1/save'] = { status: 409, detail: taken };
    world.failures['POST /kb/chats/c1/save'] = { status: 409, detail: taken };
    const { services } = renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const answer = await within(centre).findByRole('article', { name: 'Answer' });
    await user.click(within(answer).getByRole('button', { name: 'Save to wiki' }));
    expect(await within(centre).findByRole('status')).toHaveTextContent(taken);
    expect(openTarget(services.ui.getState())).toBeNull();

    await user.click(within(centre).getByRole('button', { name: /More for/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Save to wiki as analysis' }));
    await waitFor(() => expect(within(centre).getByRole('status')).toHaveTextContent(`Couldn’t save to the wiki: ${taken}`));
    expect(openTarget(services.ui.getState())).toBeNull();
  });

  it('Pin and Rename from the ⋯ menu', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: /Compare regularisation/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    await user.click(await within(centre).findByRole('button', { name: /More for/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(within(within(side()).getByRole('region', { name: 'Pinned' })).getByRole('button', { name: /Compare regularisation/ })).toBeInTheDocument());
    await user.click(within(centre).getByRole('button', { name: /More for/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = within(centre).getByRole('textbox', { name: 'Chat name' });
    await user.clear(field);
    await user.type(field, 'L1 vs L2{Enter}');
    expect(await within(centre).findByRole('heading', { name: 'L1 vs L2' })).toBeInTheDocument();
  });

  it('Regenerate with no agent: the reason stays under that answer with the way to fix it, and goes with the chat (QA D6/D10)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const claude = world.agents.agents.find((a) => a.id === 'claude_code')!;
    Object.assign(claude, { state: 'not_installed', installed: false, reason: 'Claude Code isn’t installed.', action: 'install' });
    world.failures['POST /kb/chats/c1/messages/c1-a1/regenerate'] = { status: 409, detail: 'Claude Code is not installed.' };
    const { services } = renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const answer = await within(centre).findByRole('article', { name: 'Answer' });
    await user.click(within(answer).getByRole('button', { name: 'Regenerate' }));
    const error = await within(answer).findByRole('alert');
    expect(error).toHaveTextContent('Claude Code is not installed.');
    await new Promise((r) => { window.setTimeout(r, 50); });
    expect(within(answer).getByRole('alert')).toBeInTheDocument(); // not a notice that hides itself
    await user.click(within(error).getByRole('button', { name: 'Install in Settings…' }));
    expect(services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'conn' });
    act(() => { services.ui.getState().closeSettings(); services.chats.getState().open('c2'); });
    await waitFor(() => expect(within(centre).queryByText('Claude Code is not installed.')).not.toBeInTheDocument());
  });

  it('a material deleted while its chat is open: the citation turns "no longer available" at once (QA D4/B9)', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const answer = await within(screen.getByRole('region', { name: 'Chat' })).findByRole('article', { name: 'Answer' });
    expect(within(answer).getAllByRole('button', { name: 'Source 1: Lecture 5' }).length).toBeGreaterThan(0);
    await act(async () => { await services.library.getState().forgetMaterial('m5'); });
    const sources = within(answer).getByRole('group', { name: 'Sources' });
    expect(within(sources).getByRole('button', { name: 'Source 1: Lecture 5 (no longer available)' })).toBeInTheDocument();
    await user.click(within(sources).getByRole('button', { name: /Source 1/ }));
    expect(await screen.findByText('This source is no longer available.')).toBeInTheDocument();
  });

  it('a chip to a page that is gone says "Page was removed" and opens nothing; opening a removed page offers Close, not Try again (QA D5)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const answer = world.chats.find((c) => c.id === 'c1')!.messages[1]!;
    const pagePart = answer.parts.find((p) => p.type === 'page')!;
    Object.assign(pagePart, { available: false });
    world.failures['GET /kb/wiki/pages/p-entropy'] = { status: 404, detail: 'Page not found.' };
    const { services } = renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const article = await within(screen.getByRole('region', { name: 'Chat' })).findByRole('article', { name: 'Answer' });
    const gone = within(article).getAllByRole('note', { name: 'Entropy: page was removed' })[0]!;
    expect(gone).toHaveTextContent('Page was removed');
    expect(within(article).queryByRole('button', { name: 'Wiki page: Entropy' })).not.toBeInTheDocument();

    // A page deleted after the chat was read: the panel says so and the chats mark it.
    act(() => { services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }); });
    const panel = await screen.findByRole('complementary', { name: 'Document' });
    expect(await within(panel).findByText('Page was removed from the wiki.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('an empty chat a recording opened says what it is for (QA D9)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const c2 = world.chats.find((c) => c.id === 'c2')!;
    Object.assign(c2, { messages: [], state: 'idle' });
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /What did I miss in lecture 8/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    expect(await within(centre).findByText('Ask about the lecture')).toBeInTheDocument();
  });

  it('Rename: leaving the field saves the change; an unchanged or empty name just closes it (QA D7)', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: /Compare regularisation/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    await user.click(await within(centre).findByRole('button', { name: /More for/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = within(centre).getByRole('textbox', { name: 'Chat name' });
    await user.clear(field);
    await user.type(field, 'Blurred name');
    await user.click(within(centre).getByRole('log', { name: 'Conversation' }));
    expect(await within(centre).findByRole('heading', { name: 'Blurred name' })).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.method === 'PATCH' && /\/kb\/chats\/[^/]+$/.test(c.path))).toHaveLength(1);
    await user.click(within(centre).getByRole('button', { name: /More for/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.clear(within(centre).getByRole('textbox', { name: 'Chat name' }));
    await user.click(within(centre).getByRole('log', { name: 'Conversation' }));
    expect(within(centre).queryByRole('textbox', { name: 'Chat name' })).not.toBeInTheDocument();
    expect(within(centre).getByRole('heading', { name: 'Blurred name' })).toBeInTheDocument();
  });

  it('"All chats" takes the whole centre: search, filters, folder; a row opens the chat', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: 'All chats · 7' }));
    const all = screen.getByRole('region', { name: 'All chats' });
    expect(await within(all).findByRole('button', { name: /^Transformer paper review/ })).toBeInTheDocument();
    // The Folder label and its select are one unit, so a narrow toolbar wraps them together (QA D16).
    expect(within(within(all).getByTestId('allchats-folder')).getByRole('combobox', { name: 'Folder' })).toBeInTheDocument();
    await user.click(within(all).getByRole('radio', { name: 'Pinned' }));
    await waitFor(() => expect(within(all).queryByRole('button', { name: /^Transformer paper review/ })).not.toBeInTheDocument());
    expect(within(all).getByRole('button', { name: /^Exam preparation for ML/ })).toBeInTheDocument();
    await user.click(within(all).getByRole('radio', { name: 'All' }));
    await user.type(within(all).getByRole('searchbox', { name: 'Find in chats' }), 'regular');
    await waitFor(() => expect(within(all).getAllByRole('button', { name: /^Compare regularisation/ })).toHaveLength(1));
    await user.click(within(all).getByRole('button', { name: /^Compare regularisation/ }));
    expect(await screen.findByRole('heading', { name: 'Compare regularisation approaches' })).toBeInTheDocument();
  });
});

describe('Answer text', () => {
  it('safe Markdown: raw HTML is text, script links and images are not live; chips stay inline', () => {
    render(
      <InlineMarkdown
        pieces={['See <img src=x onerror="alert(1)"> and [bad](javascript:alert(1)) and [ok](https://example.org) ', 0, ' **done** ![pic](https://t.example/x.png)']}
        slot={(i, key) => <button key={key} type="button">chip {i}</button>}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', 'https://example.org/');
    expect(screen.getByRole('button', { name: 'chip 0' }).closest('p')).toHaveTextContent('chip 0 done');
  });

  it('an ordered list keeps its first number (a list saved as separate blocks no longer restarts at 1)', () => {
    const { container } = render(<InlineMarkdown pieces={['2. two\n3. three']} slot={() => null} />);
    expect(container.querySelector('ol')).toHaveAttribute('start', '2');
    const { container: wiki } = render(<AnswerMarkdown content={'3. three'} citations={[]} activeSessionId={null} onCite={() => undefined} />);
    expect(wiki.querySelector('ol')).toHaveAttribute('start', '3');
    const { container: first } = render(<InlineMarkdown pieces={['1. one']} slot={() => null} />);
    expect(first.querySelector('ol')).not.toHaveAttribute('start');
  });

  it('forgetInChat: a gone page/material is marked in every part; nothing else changes identity', () => {
    const chat = chatWorld().chats.find((c) => c.id === 'c1')!;
    expect(forgetInChat(chat, { material: 'm-unrelated' })).toBe(chat);
    const after = forgetInChat(forgetInChat(chat, { page: 'p-entropy' }), { material: 'm1' });
    const parts = after.messages[1]!.parts;
    expect(parts.filter((p) => p.type === 'page').every((p) => p.type === 'page' && p.available === false)).toBe(true);
    const conn = parts.find((p) => p.type === 'connection');
    if (conn?.type !== 'connection') throw new Error('connection expected');
    expect(conn.folders.find((f) => f.citation.material_id === 'm1')!.citation.available).toBe(false);
    expect(conn.folders.filter((f) => f.citation.material_id !== 'm1').every((f) => f.citation.available)).toBe(true);
    expect(after.messages[0]).toBe(chat.messages[0]);
  });

  it('parts: text/cite/page flow as one run; a connection is its own block; tools are not text', () => {
    const state = chatWorld();
    const parts = state.chats.find((c) => c.id === 'c1')!.messages[1]!.parts;
    const blocks = toBlocks(parts);
    expect(blocks.map((b) => b.kind)).toEqual(['inline', 'connection']);
    // Copy keeps the Markdown the agent wrote; chips become their names.
    expect(plainText(parts)).toMatch(/^Cross-entropy is \*\*Shannon entropy\*\* applied to the model’s error Entropy\./);
    expect(plainText(parts)).not.toMatch(/Read page/);
  });

  it('parts: citations side by side are one claim — one slot, the space before them dropped', () => {
    const c = (seg: number) => ({ material_id: 's1', seg, available: true, material_title: 'Seminar', start_ms: null, end_ms: null, page: 1, quote: 'q' });
    const blocks = toBlocks([
      { type: 'text', text: 'One clear recommendation. ' },
      { type: 'cite', citation: c(1) }, { type: 'text', text: ' ' }, { type: 'cite', citation: c(1) },
      { type: 'cite', citation: c(2) },
      { type: 'text', text: ' Next claim' }, { type: 'cite', citation: c(2) },
    ]);
    expect(blocks).toHaveLength(1);
    const run = blocks[0]!;
    if (run.kind !== 'inline') throw new Error('inline run expected');
    expect(run.pieces).toEqual(['One clear recommendation.', 0, ' Next claim', 1]);
    expect(run.slots.map((s) => (s.type === 'cites' ? s.citations.map((x) => x.seg) : s.type))).toEqual([[1, 1, 2], [2]]);
  });
});
