import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { toHits } from './CommandK';
import { openTarget } from '../state/document';

const openK = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  return screen.findByRole('dialog', { name: 'Search' });
};

describe('⌘K', () => {
  it('never shows "Nothing found" before the answer for that query has arrived (QA E8)', async () => {
    renderKb({ world: chatWorld() });
    const dialog = await openK();
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach((node) => seen.push(node.textContent ?? ''));
    });
    observer.observe(dialog, { childList: true, subtree: true, characterData: true });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'entropy' } });
    await waitFor(() => expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(2));
    observer.takeRecords().forEach((record) => record.addedNodes.forEach((node) => seen.push(node.textContent ?? '')));
    observer.disconnect();
    expect(seen.filter((text) => text.includes('Nothing found'))).toEqual([]);
    // A query that really has no hits still says so once its answer is in.
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'zzqqxx' } });
    expect(await within(dialog).findByText('Nothing found for “zzqqxx”.')).toBeInTheDocument();
  });

  it('a failing text index says search is unavailable, never "Nothing found" (L1)', async () => {
    const world = chatWorld();
    world.searchDegraded = true;
    renderKb({ world });
    const dialog = await openK();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'zzqqxx' } });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('isn’t available right now');
    expect(within(dialog).queryByText(/Nothing found/)).not.toBeInTheDocument();
  });

  it('↑/↓ keep the highlighted result on screen in a long list (L5)', async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this.id); };
    try {
      renderKb({ world: chatWorld() });
      const dialog = await openK();
      fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'entropy' } });
      await waitFor(() => expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(2));
      fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'ArrowDown' });
      const active = within(dialog).getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')!;
      await waitFor(() => expect(scrolled).toContain(active.id));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('⌘K and the rail button open it; sections with counts, three per section in All, matches marked', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openK();
    const input = within(dialog).getByRole('combobox', { name: 'Search the wiki, materials and chats' });
    expect(input).toHaveFocus();
    await user.type(input, 'entrop');
    const tabs = within(dialog).getByRole('tablist', { name: 'Sections' });
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: /Wiki/ })).toHaveTextContent('Wiki5'));
    expect(within(tabs).getByRole('tab', { name: /Chats/ })).toHaveTextContent('Chats2');
    const list = within(dialog).getByRole('listbox', { name: 'Results' });
    // At most three per section in "All", plus the "Ask the agent" row.
    expect(within(list).getAllByRole('option').length).toBeLessThanOrEqual(3 * 3 + 1);
    expect(list.querySelectorAll('mark.kb-hl').length).toBeGreaterThan(0);
    expect(within(list).getByRole('option', { name: /Ask the agent: “entrop”/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeInTheDocument();
  });

  it('↓ and Enter open the chosen result on the right; Tab switches the section', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: chatWorld() });
    const dialog = await openK();
    await user.type(within(dialog).getByRole('combobox'), 'entropy');
    await waitFor(() => expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(2));
    await user.keyboard('{Tab}');
    expect(within(dialog).getByRole('tab', { name: /Wiki/ })).toHaveAttribute('aria-selected', 'true');
    const first = within(dialog).getAllByRole('option')[0]!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument());
    expect(openTarget(services.ui.getState())).toMatchObject({ type: 'page', id: 'p-entropy' });
  });

  it('⌘Enter asks the agent: a new chat with the query sent', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const dialog = await openK();
    await user.type(within(dialog).getByRole('combobox'), 'why log in loss');
    expect(within(dialog).getByRole('option', { name: /Ask the agent: “why log in loss”\s*in a new chat/ })).toBeInTheDocument();
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument());
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'POST' && /\/messages$/.test(c.path))?.body).toMatchObject({ text: 'why log in loss' }));
  });

  it('a draft in the field is never mixed into the question nor sent, and is still there afterwards (QA D3/A22)', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ world: chatWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('DRAFT-X half written');
    const dialog = await openK();
    await user.type(within(dialog).getByRole('combobox'), 'hello search');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument());
    const sent = () => fake.calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path)).map((c) => (c.body as { text: string }).text);
    await waitFor(() => expect(sent()).toEqual(['hello search']));
    // The question went to a new chat; its field is empty, New chat still holds the draft.
    await waitFor(() => expect(services.chats.getState().currentId).not.toBeNull());
    expect(screen.getByTestId('message-input')).toHaveTextContent(/^$/);
    services.chats.getState().open(null);
    await waitFor(() => expect(screen.getByTestId('message-input')).toHaveTextContent('DRAFT-X half written'));
    expect(sent()).toEqual(['hello search']);
  });

  it('from an open chat with no agent: nothing is sent or lost — the reason and its fix stay in the palette (QA D2/D6)', async () => {
    const user = userEvent.setup();
    const w = chatWorld();
    w.agents.default = 'hermes';
    const { fake, services } = renderKb({ world: w });
    const chatId = w.chats[0]!.id;
    services.chats.getState().open(chatId);
    const dialog = await openK();
    await user.type(within(dialog).getByRole('combobox'), 'What is entropy');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Hermes Agent can’t answer now: Hermes Agent isn’t installed.');
    expect(within(dialog).getByRole('combobox')).toHaveValue('What is entropy');
    expect(fake.calls.some((c) => c.method === 'POST' && /\/messages$/.test(c.path))).toBe(false);
    expect(services.chats.getState().currentId).toBe(chatId);
    await user.click(within(dialog).getByRole('button', { name: 'Install in Settings…' }));
    expect(services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'conn', searchOpen: false });
  });

  it('a chat result opens the chat', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openK();
    await user.type(within(dialog).getByRole('combobox'), 'regularisation');
    await waitFor(() => expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(1));
    // Matches are split into <mark>s, so find the row by its text.
    await user.click(within(dialog).getAllByRole('option').find((o) => o.textContent?.includes('Compare regularisation approaches'))!);
    expect(await screen.findByRole('heading', { name: 'Compare regularisation approaches' })).toBeInTheDocument();
  });

  it('a page and its blocks are one row; fragments of one material are one row', () => {
    const hits = toHits({
      query: 'e', counts: null,
      pages: [{ id: 'p1', title: 'Entropy', kind: 'concept', matched_alias: null }],
      blocks: [
        { page_id: 'p1', page_title: 'Entropy', page_kind: 'concept', block_id: 'b1', kind: 'from_source', owner: 'agent', snippet: [] },
        { page_id: 'p2', page_title: 'Notes', page_kind: 'note', block_id: 'b2', kind: 'from_source', owner: 'agent', snippet: [] },
      ],
      fragments: [
        { material_id: 'm1', material_title: 'Lecture', material_kind: 'recording', seg: 1, start_ms: 1000, page: null, snippet: [] },
        { material_id: 'm1', material_title: 'Lecture', material_kind: 'recording', seg: 2, start_ms: 2000, page: null, snippet: [] },
      ],
      materials: [],
    } as never, null);
    expect(hits.map((h) => h.key)).toEqual(['p-p1', 'b-p2-b2', 'f-m1-1']);
  });
});
