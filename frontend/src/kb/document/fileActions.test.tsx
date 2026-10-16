import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import type { KbBridge } from '../state/context';

async function openPage(id: string, bridge: Partial<KbBridge>) {
  const r = renderKb({ world: docWorld(), bridge });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type: 'page', id }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  await within(doc).findByRole('heading', { level: 2 });
  return { ...r, doc };
}

describe('Open in Obsidian (B20)', () => {
  it('Settings → Storage opens the library as a vault; without Obsidian it says so with the download link', async () => {
    const openInObsidian = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: 'not_installed' });
    renderKb({ world: docWorld(), bridge: { openInObsidian } });
    await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Storage/ }));
    const row = within(dialog).getByRole('group', { name: 'Open in Obsidian' });
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'Open in Obsidian' }));
    expect(openInObsidian).toHaveBeenCalledWith({ kind: 'library' });
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Open in Obsidian' }));
    const alert = await within(row).findByRole('alert');
    expect(alert).toHaveTextContent('Obsidian isn’t installed on this Mac.');
    expect(within(alert).getByRole('link', { name: /Download Obsidian/ })).toHaveAttribute('href', 'https://obsidian.md/download');
  });

  it('Obsidian open and not knowing the library: asks, and only the user’s yes restarts it (live 16.10)', async () => {
    const openInObsidian = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'obsidian_running' })
      .mockResolvedValueOnce({ ok: true });
    renderKb({ world: docWorld(), bridge: { openInObsidian } });
    await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Storage/ }));
    const row = within(dialog).getByRole('group', { name: 'Open in Obsidian' });
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'Open in Obsidian' }));
    expect(await within(row).findByText(/Obsidian is open and doesn’t know the library yet/)).toBeInTheDocument();
    expect(openInObsidian).toHaveBeenCalledTimes(1);
    await user.click(within(row).getByRole('button', { name: 'Restart Obsidian and open' }));
    await waitFor(() => expect(openInObsidian).toHaveBeenLastCalledWith({ kind: 'library' }, { restart: true }));
    await waitFor(() => expect(within(row).queryByRole('button', { name: 'Restart Obsidian and open' })).not.toBeInTheDocument());
  });

  it('page ⋯ → Open in Obsidian opens that page (main resolves its file)', async () => {
    const openInObsidian = vi.fn(async () => ({ ok: true as const }));
    const { doc } = await openPage('p-entropy', { openInObsidian });
    const user = userEvent.setup();
    await user.click(within(doc).getByRole('button', { name: 'Page actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Open in Obsidian/ }));
    await waitFor(() => expect(openInObsidian).toHaveBeenCalledWith({ kind: 'page', id: 'p-entropy' }));
  });

  it('outside the desktop app there is no Obsidian item', async () => {
    const { doc } = await openPage('p-entropy', {});
    const user = userEvent.setup();
    await user.click(within(doc).getByRole('button', { name: 'Page actions' }));
    await screen.findByRole('menuitem', { name: /Read the page again/ });
    expect(screen.queryByRole('menuitem', { name: /Open in Obsidian/ })).not.toBeInTheDocument();
  });
});
