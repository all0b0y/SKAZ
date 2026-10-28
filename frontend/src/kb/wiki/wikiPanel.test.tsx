import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { baseWorld, docWorld } from '../test/fakeBridge';

async function wikiPanel() {
  const r = renderKb({ world: docWorld() });
  const rail = await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.click(within(rail).getByRole('button', { name: /^Wiki/ }));
  await screen.findByRole('heading', { name: 'Sections', level: 3 });
  return r;
}

describe('Wiki panel: search, Index and Log (B20)', () => {
  it('searches titles and text through the index; ↑↓ move, Enter opens, Esc clears', async () => {
    const user = userEvent.setup();
    const { fake } = await wikiPanel();
    const field = screen.getByRole('combobox', { name: 'Search the wiki' });
    await user.type(field, 'entropy');
    const list = await screen.findByRole('listbox', { name: 'Wiki pages found' });
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBeGreaterThan(1));
    expect(fake.calls.some((c) => c.method === 'GET' && c.path === '/kb/search' && (c.query as Record<string, unknown>).q === 'entropy')).toBe(true);
    const options = within(list).getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(within(list).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(field).toHaveAttribute('aria-activedescendant', within(list).getAllByRole('option')[1]!.id);
    await user.keyboard('{ArrowUp}{Enter}');
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    expect(await within(doc).findByRole('heading', { level: 2 })).toHaveTextContent(within(list).getAllByRole('option')[0]!.querySelector('.kb-wsearch__title')!.textContent!);
    await user.click(field);
    await user.keyboard('{Escape}');
    expect(field).toHaveValue('');
    expect(screen.queryByRole('listbox', { name: 'Wiki pages found' })).not.toBeInTheDocument();
  });

  it('says plainly when nothing matches', async () => {
    const user = userEvent.setup();
    await wikiPanel();
    await user.type(screen.getByRole('combobox', { name: 'Search the wiki' }), 'zzzqqq');
    expect(await screen.findByText('No pages match “zzzqqq”.')).toBeInTheDocument();
  });

  it('Index and Log open Wiki/index.md and Wiki/log.md read-only, links open pages', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    world.wikiFiles = {
      index: { text: '# Index\n\n## Concepts\n\n- [[Wiki/Concepts/Entropy|Entropy]] — a measure of disorder\n', links: [{ target: 'Wiki/Concepts/Entropy', page: { id: 'p-entropy', kind: 'concept', title: 'Entropy' }, material_id: null }] },
      log: { text: '# Log\n\n- 2026-10-15 09:12 UTC — Notes created: Lecture 8\n', links: [] },
    };
    renderKb({ world });
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.click(within(rail).getByRole('button', { name: /^Wiki/ }));
    await user.click(await screen.findByRole('button', { name: 'Index' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    expect(await within(doc).findByRole('heading', { level: 2, name: 'Index' })).toBeInTheDocument();
    expect(within(doc).getByText(/Read-only/)).toBeInTheDocument();
    expect(within(doc).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(doc).queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    await user.click(within(doc).getByRole('button', { name: 'Entropy' }));
    expect(await within(doc).findByRole('heading', { level: 2, name: 'Entropy' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log' }));
    expect(await within(doc).findByRole('heading', { level: 2, name: 'Log' })).toBeInTheDocument();
    expect(within(doc).getByText(/Notes created: Lecture 8/)).toBeInTheDocument();
  });
});

describe('Selecting several wiki pages (0.3.1 F4)', () => {
  async function concepts() {
    const user = userEvent.setup();
    const r = await wikiPanel();
    // Concepts is the section open by default (decision 24 «Wiki»).
    expect(screen.getByRole('button', { name: /^Concepts/ })).toHaveAttribute('aria-expanded', 'true');
    const grid = await screen.findByRole('grid', { name: 'Concepts' });
    const rowOf = (name: string) => within(grid).getByRole('button', { name: new RegExp(`^${name}`) }).closest('[role="row"]') as HTMLElement;
    const tick = async (...names: string[]) => { for (const n of names) await user.click(rowOf(n).querySelector('[data-sel-box]')!); };
    return { ...r, user, grid, rowOf, tick };
  }

  it('Index and Log can’t be selected and say why', async () => {
    await wikiPanel();
    expect(screen.getByRole('button', { name: 'Index' })).toHaveAttribute('title', 'SKAZ keeps Index and Log — they can’t be selected');
    expect(screen.getByRole('button', { name: 'Log' })).not.toHaveAttribute('aria-selected');
  });

  it('“Ask in chat” attaches the selected pages as @; the bar has Export, ⋯ and Delete', async () => {
    const { user, tick, services } = await concepts();
    const titles = within(screen.getByRole('grid', { name: 'Concepts' })).getAllByRole('row').slice(0, 2)
      .map((r) => r.textContent ?? '');
    await tick(titles[0]!, titles[1]!);
    const bar = screen.getByRole('toolbar', { name: '2 selected' });
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Ask in chat', 'Export .md', 'More actions', 'Delete', 'Clear selection']);
    await user.click(within(bar).getByRole('button', { name: 'Ask in chat' }));
    expect(services.ui.getState().center).toBe('chat');
    const input = await screen.findByTestId('message-input');
    await waitFor(() => expect([...input.querySelectorAll('.kb-token--mention')].map((t) => t.textContent)).toEqual(
      titles.map((t) => expect.stringContaining(t)),
    ));
  });

  it('Delete builds one window from the page previews, then deletes one by one', async () => {
    const { user, grid, tick, fake } = await concepts();
    const titles = within(grid).getAllByRole('row').slice(0, 2).map((r) => r.textContent ?? '');
    await tick(titles[0]!, titles[1]!);
    await user.click(within(screen.getByRole('toolbar', { name: '2 selected' })).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 pages?' });
    expect(fake.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/delete-preview'))).toHaveLength(2);
    expect(dialog).toHaveTextContent('Materials stay');
    await user.click(await within(dialog).findByRole('button', { name: 'Delete 2' }));
    expect(await screen.findByTestId('toast')).toHaveTextContent('Deleted 2 pages');
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });
});

describe('Wiki kind sections fold in place (decisions 24 «Wiki», 27)', () => {
  const side = () => screen.getByRole('region', { name: 'Wiki' });

  it('each kind is a header row with a chevron and a count; Concepts open, the rest folded; no drill-in, no back step', async () => {
    await wikiPanel();
    const heads = ['Concepts', 'Notes', 'Analyses', 'Folder overviews', 'Decks', 'Tests']
      .map((name) => within(side()).getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) }));
    expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
    expect(heads[0]).toHaveTextContent('22');
    expect(heads[0]!.querySelector('.kb-wfold__chev')).toHaveClass('is-open');
    expect(within(side()).queryByRole('button', { name: 'Wiki' })).not.toBeInTheDocument();
    // A folded body is inert: its rows are out of the tab order and the accessibility tree.
    const notes = document.getElementById(heads[1]!.getAttribute('aria-controls')!)!;
    expect(notes.querySelector('.kb-fold__in')).toHaveAttribute('inert');
    // Graph, Index and Log stay below the sections.
    expect(within(side()).getByRole('button', { name: 'Graph of connections' })).toBeInTheDocument();
  });

  it('a header folds and unfolds its section in place; the choice is kept in prefs', async () => {
    const user = userEvent.setup();
    const { services } = await wikiPanel();
    const concepts = within(side()).getByRole('button', { name: /^Concepts/ });
    const grid = screen.getByRole('grid', { name: 'Concepts' });
    await user.click(concepts);
    expect(concepts).toHaveAttribute('aria-expanded', 'false');
    expect(services.prefs.getState().wikiOpen.concept).toBe(false);
    // Folding keeps the rows mounted (the same list node), only inert.
    expect(grid.isConnected).toBe(true);
    await user.click(within(side()).getByRole('button', { name: /^Analyses/ }));
    expect(services.prefs.getState().wikiOpen).toMatchObject({ concept: false, analysis: true });
    await user.click(concepts);
    expect(screen.getByRole('grid', { name: 'Concepts' })).toBe(grid);
  });

  it('an open section with no pages says how pages of that kind appear', async () => {
    const user = userEvent.setup();
    await wikiPanel();
    const empty = ['Concepts', 'Notes', 'Analyses', 'Folder overviews', 'Decks', 'Tests']
      .map((name) => within(side()).getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) }))
      .find((h) => h.textContent!.endsWith('0'));
    expect(empty, 'the doc world has a kind with no pages').toBeTruthy();
    await user.click(empty!);
    const body = document.getElementById(empty!.getAttribute('aria-controls')!)!;
    expect(within(body).getByText(/yet$/)).toBeInTheDocument();
  });

  it('an empty wiki says only «The wiki is empty»: no per-kind hint in the open section (FIX1 R6)', async () => {
    renderKb({ world: baseWorld(), prefs: { section: 'wiki' } });
    expect(await within(await screen.findByRole('region', { name: 'Wiki' })).findByText('The wiki is empty')).toBeInTheDocument();
    const concepts = within(side()).getByRole('button', { name: /^Concepts\s*0$/ });
    expect(concepts).toHaveAttribute('aria-expanded', 'true');
    const body = document.getElementById(concepts.getAttribute('aria-controls')!)!;
    expect(within(body).queryByText(/yet$/)).not.toBeInTheDocument();
    expect(within(side()).queryByText(/^No \w+ yet$/)).not.toBeInTheDocument();
  });

  it('the kind sections add no landmarks inside the Wiki region; each list keeps its name (FIX1 R8)', async () => {
    await wikiPanel();
    expect(within(side()).queryAllByRole('region')).toEqual([]);
    expect(screen.getByRole('grid', { name: 'Concepts' })).toBeInTheDocument();
  });

  it('opening another page never remounts the list: same row nodes, a soft tile moves', async () => {
    const user = userEvent.setup();
    await wikiPanel();
    const grid = screen.getByRole('grid', { name: 'Concepts' });
    const [first, second] = within(grid).getAllByRole('row').map((r) => r.querySelector('button.kb-row') as HTMLElement);
    const rowsBefore = [...grid.querySelectorAll('[data-tab-key]')];
    await user.click(first!);
    expect(first).toHaveClass('is-current');
    const tab = grid.parentElement!.querySelector('[data-testid="active-tab"]')!;
    expect(tab).toHaveClass('kb-tab--soft');
    expect(tab).toHaveAttribute('data-tab-for', first!.dataset.tabKey);
    await user.click(second!);
    expect(first!.isConnected).toBe(true);
    expect([...screen.getByRole('grid', { name: 'Concepts' }).querySelectorAll('[data-tab-key]')]).toEqual(rowsBefore);
    expect(screen.getByRole('grid', { name: 'Concepts' })).toBe(grid);
    expect(first).not.toHaveClass('is-current');
    expect(second).toHaveClass('is-current');
    expect(tab).toHaveAttribute('data-tab-for', second!.dataset.tabKey);
  });
});
