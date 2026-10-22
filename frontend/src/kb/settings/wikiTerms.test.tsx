import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import { searchRows } from './schema';

/** The confirmed legend (wiki-terms v1, variant A): 15 terms, 3 groups, one line each. */
const LEGEND: ReadonlyArray<[string, ReadonlyArray<[string, string]>]> = [
  ['Pages', [
    ['Notes', 'What one material says. One page per material.'],
    ['Concept', 'One idea, gathered from all your materials.'],
    ['Folder', 'Overview of a folder: topics, materials in order.'],
    ['Analysis', 'A saved chat answer. Never cited as a source.'],
    ['Deck · Test', 'Cards or a test made from your materials.'],
  ]],
  ['Statement labels', [
    ['From sources', 'Said in a material, checked against the quote.'],
    ['Agent explanation', 'The agent’s own words, not a source. Editable.'],
    ['Connection — agent inference', 'A link the agent inferred. You can delete it.'],
    ['My note', 'Yours. The agent never changes it.'],
    ['Edited by you', 'An agent statement you changed.'],
  ]],
  ['On a page', [
    ['Source number', 'Click it for the exact quote and the place.'],
    ['Related · Mentioned in', 'Pages it links to · pages that link here.'],
    ['Decide', 'Sources differ. You choose, not the agent.'],
    ['Re-check against sources', 'The agent rewrites it from its quotes.'],
    ['Paused · budget reached', 'Budget used up. Continue resumes.'],
  ]],
];

/** Group → [term name, meaning] as the legend shows them; the name is what a screen reader hears. */
function readLegend(legend: HTMLElement): Array<[string, Array<[string, string]>]> {
  return Array.from(legend.querySelectorAll<HTMLElement>('[data-legend-group]')).map((group) => [
    within(group).getByRole('heading').textContent ?? '',
    within(group).getAllByRole('term').map((dt) => {
      const dd = dt.nextElementSibling as HTMLElement;
      expect(dd.tagName).toBe('DD');
      expect(dd).toHaveAttribute('title', dd.textContent);
      return [dt.querySelector('.kb-visually-hidden')?.textContent ?? '', dd.textContent ?? ''];
    }),
  ]);
}

async function openPage() {
  const r = renderKb({ world: docWorld() });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  await within(doc).findByRole('heading', { level: 2, name: 'Entropy' });
  return { ...r, doc };
}

describe('Wiki terms: the legend on “?” (wiki-terms v1, variant A)', () => {
  it('“?” on a wiki page opens a legend: 15 terms in 3 groups, each drawn as on the page, one line each', async () => {
    const user = userEvent.setup();
    const { doc } = await openPage();
    const help = within(doc).getByRole('button', { name: 'What these labels mean' });
    expect(help).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(help);
    const legend = await screen.findByRole('dialog', { name: 'What the wiki labels mean' });
    expect(help).toHaveAttribute('aria-expanded', 'true');
    expect(within(legend).getByText('What the wiki labels mean')).toBeInTheDocument();
    expect(readLegend(legend)).toEqual(LEGEND);
    // Samples are the app's own labels: statement labels, the source number, the paused pill.
    for (const kind of ['from_source', 'explanation', 'connection', 'user_note', 'edited']) {
      expect(legend.querySelector(`.kb-claim[data-claim="${kind}"]`), kind).not.toBeNull();
    }
    expect(legend.querySelector('.kb-claim[data-claim="connection"]')).toHaveTextContent('Connection — agent inference');
    expect(legend.querySelector('.kb-cn')).toHaveTextContent('1');
    expect(legend.querySelector('.kb-pst--warn')).toHaveTextContent('Paused · budget reached');
    expect(legend.querySelectorAll('[data-legend-group="Pages"] .kb-icon').length).toBe(5);
    // Nothing here is a settings row: no switches, no inputs.
    expect(within(legend).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(legend).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('closes with Esc (focus back on “?”), with ✕ and with a click outside; it is reachable by keyboard', async () => {
    const user = userEvent.setup();
    const { doc } = await openPage();
    const help = within(doc).getByRole('button', { name: 'What these labels mean' });
    help.focus();
    await user.keyboard('{Enter}');
    let legend = await screen.findByRole('dialog', { name: 'What the wiki labels mean' });
    await waitFor(() => expect(legend).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'What the wiki labels mean' })).not.toBeInTheDocument());
    expect(help).toHaveFocus();
    // The document stays open: Esc closed only the legend.
    expect(screen.getByRole('complementary', { name: 'Document' })).toBeInTheDocument();
    await user.click(help);
    legend = await screen.findByRole('dialog', { name: 'What the wiki labels mean' });
    await user.click(within(legend).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'What the wiki labels mean' })).not.toBeInTheDocument());
    await user.click(help);
    await screen.findByRole('dialog', { name: 'What the wiki labels mean' });
    fireEvent.mouseDown(within(doc).getByRole('heading', { level: 2, name: 'Entropy' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'What the wiki labels mean' })).not.toBeInTheDocument());
  });

  it('“?” on the Wiki panel opens the same legend; its footer opens Settings → Wiki and Models', async () => {
    const user = userEvent.setup();
    const r = renderKb({ world: docWorld(), prefs: { section: 'wiki' } });
    const side = await screen.findByRole('region', { name: 'Wiki' });
    await user.click(await within(side).findByRole('button', { name: 'What these labels mean' }));
    let legend = await screen.findByRole('dialog', { name: 'What the wiki labels mean' });
    expect(readLegend(legend)).toEqual(LEGEND);
    expect(legend).toHaveTextContent('Model, budget and connection settings: Settings → Wiki and Models.');
    await user.click(within(legend).getByRole('button', { name: 'Settings → Wiki' }));
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(r.services.ui.getState().settingsSection).toBe('wiki');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'What the wiki labels mean' })).not.toBeInTheDocument());
    act(() => r.services.ui.getState().closeSettings());
    await user.click(within(side).getByRole('button', { name: 'What these labels mean' }));
    legend = await screen.findByRole('dialog', { name: 'What the wiki labels mean' });
    await user.click(within(legend).getByRole('button', { name: 'Models' }));
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(r.services.ui.getState().settingsSection).toBe('models');
  });
});

describe('Settings → Wiki → Help → Wiki terms', () => {
  async function openSettings() {
    const r = renderKb({ world: docWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    return { ...r, dialog };
  }

  it('the long list is gone; the last group “Help” has one row whose “Show…” opens the same legend', async () => {
    const user = userEvent.setup();
    const { dialog } = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Wiki' }));
    const groups = Array.from(dialog.querySelectorAll('.kb-sgroup')).map((g) => g.getAttribute('aria-label'));
    expect(groups).not.toContain('Wiki terms');
    expect(groups.at(-1)).toBe('Help');
    expect(within(dialog).queryAllByRole('term')).toEqual([]);
    const help = within(dialog).getByRole('region', { name: 'Help' });
    const row = within(help).getByRole('group', { name: 'Wiki terms' });
    expect(row).toHaveTextContent('What each label on a wiki page means');
    const show = within(row).getByRole('button', { name: 'Show…' });
    expect(show.querySelector('.kb-icon')).not.toBeNull();
    await user.click(show);
    const legend = await screen.findByRole('dialog', { name: 'What the wiki labels mean' });
    expect(readLegend(legend)).toEqual(LEGEND);
    // Esc closes the legend, not Settings; focus goes back to “Show…”.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'What the wiki labels mean' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(show).toHaveFocus();
    // Its footer moves Settings to Models.
    await user.click(show);
    await user.click(within(await screen.findByRole('dialog', { name: 'What the wiki labels mean' })).getByRole('button', { name: 'Models' }));
    await waitFor(() => expect(within(dialog).getByRole('heading', { level: 3, name: 'Models' })).toBeInTheDocument());
  });

  it('the settings search finds the row by any term’s name or a word of its meaning', async () => {
    for (const [, terms] of LEGEND) {
      for (const [name, meaning] of terms) {
        expect(searchRows(name).map((r) => r.id), name).toContain('wiki-terms');
        expect(searchRows(meaning).map((r) => r.id), meaning).toContain('wiki-terms');
      }
    }
    const user = userEvent.setup();
    const { dialog } = await openSettings();
    const search = within(dialog).getByRole('searchbox', { name: 'Find a setting' });
    await user.type(search, 'budget reached');
    expect(within(dialog).getByRole('group', { name: 'Wiki terms' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'agent inference');
    const row = within(dialog).getByRole('group', { name: 'Wiki terms' });
    await user.click(within(row).getByRole('button', { name: 'Show…' }));
    expect(await screen.findByRole('dialog', { name: 'What the wiki labels mean' })).toBeInTheDocument();
  });
});
