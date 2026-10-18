import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';

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
    await user.click(screen.getByRole('button', { name: /^Concepts/ }));
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
