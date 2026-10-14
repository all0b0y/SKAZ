import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb, storedPrefs } from '../test/renderKb';
import { notConfiguredState } from '../test/fakeBridge';
import { ROWS, searchRows } from './schema';

const openWithShortcut = async () => {
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  return screen.findByRole('dialog', { name: 'Settings' });
};

describe('Settings window', () => {
  it('⌘, and the gear open it; groups and sections follow the agreed structure', async () => {
    const user = userEvent.setup();
    renderKb();
    await screen.findByRole('navigation', { name: 'Sections' });
    const dialog = await openWithShortcut();
    const nav = within(dialog).getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('heading').map((h) => h.textContent)).toEqual(['Connections', 'Work', 'App']);
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Accounts & keys', 'Models', 'Recording & speech', 'Wiki', 'Storage', 'Privacy', 'Appearance', 'About',
    ]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument());
    const gear = screen.getByRole('button', { name: /^Settings/ });
    await user.click(gear);
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  it('search finds rows across sections and switching section clears it', async () => {
    const user = userEvent.setup();
    renderKb();
    const dialog = await openWithShortcut();
    const search = within(dialog).getByRole('searchbox', { name: 'Find a setting' });
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, 'dark');
    expect(within(dialog).getByRole('heading', { name: 'Search' })).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Appearance' })).toBeInTheDocument();
    expect(within(dialog).getByText('Theme')).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'zzzz');
    expect(within(dialog).getByText('No settings match “zzzz”.')).toBeInTheDocument();
    // Escape in the search clears it first; the window stays open.
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await user.type(search, 'key');
    await user.click(within(dialog).getByRole('button', { name: 'Storage' }));
    expect(search).toHaveValue('');
    expect(within(dialog).getByRole('heading', { name: 'Storage', level: 3 })).toBeInTheDocument();
  });

  it('the search table covers every row and matches synonyms', () => {
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(ROWS.length);
    expect(searchRows('obsidian').map((r) => r.id)).toEqual(['obsidian']);
    expect(searchRows('soniox').map((r) => r.section)).toEqual(expect.arrayContaining(['conn', 'privacy']));
    expect(searchRows('')).toEqual([]);
  });

  it('Storage shows the real library root; Appearance changes theme and text size for real', async () => {
    const user = userEvent.setup();
    renderKb();
    const dialog = await openWithShortcut();
    await user.click(within(dialog).getByRole('button', { name: 'Storage' }));
    const folderRow = within(dialog).getByRole('group', { name: 'Folder' });
    expect(await within(folderRow).findByText('/Users/me/Documents/SKAZ')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Appearance' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(within(dialog).getByRole('radio', { name: 'Large' }));
    expect(document.documentElement.dataset.textSize).toBe('l');
    expect(storedPrefs()).toMatchObject({ theme: 'dark', textSize: 'l' });
    await user.click(within(dialog).getByRole('radio', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('sections without a backend yet say "Not connected yet" and their controls are inactive', async () => {
    const user = userEvent.setup();
    renderKb();
    const dialog = await openWithShortcut();
    await user.click(within(dialog).getByRole('button', { name: 'Models' }));
    expect(within(dialog).getAllByText('Not connected yet').length).toBeGreaterThanOrEqual(5);
    for (const radio of within(dialog).getAllByRole('radio')) expect(radio).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Wiki' }));
    for (const sw of within(dialog).getAllByRole('switch')) expect(sw).toBeDisabled();
  });

  it('a library problem is the only coloured spot: banner in Storage, dot on the section and the gear', async () => {
    const user = userEvent.setup();
    renderKb({ state: notConfiguredState() });
    expect(await screen.findByTestId('settings-dot')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Settings/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    // The gear opens the section with the problem.
    expect(within(dialog).getByRole('heading', { name: 'Storage', level: 3 })).toBeInTheDocument();
    const storage = within(dialog).getByRole('button', { name: /Storage/ });
    expect(within(storage).getByRole('img', { name: 'Needs attention' })).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toHaveTextContent('The library isn’t connected.');
  });
});
