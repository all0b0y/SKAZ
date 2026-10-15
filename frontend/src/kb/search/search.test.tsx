import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { b2State } from '../test/fakeB2';
import { toHits } from './CommandK';
import { openTarget } from '../state/document';

const openK = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  return screen.findByRole('dialog', { name: 'Search' });
};

describe('⌘K', () => {
  it('⌘K and the rail button open it; sections with counts, three per section in All, matches marked', async () => {
    const user = userEvent.setup();
    renderKb({ b2: b2State() });
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
    const { services } = renderKb({ b2: b2State() });
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
    const { fake } = renderKb({ b2: b2State() });
    const dialog = await openK();
    await user.type(within(dialog).getByRole('combobox'), 'why log in loss');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument());
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'POST' && /\/messages$/.test(c.path))?.body).toMatchObject({ text: 'why log in loss' }));
  });

  it('a chat result opens the chat', async () => {
    const user = userEvent.setup();
    renderKb({ b2: b2State() });
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
