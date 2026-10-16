import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import type { KbBridge } from '../state/context';

async function openPage(id: string, bridge: Partial<KbBridge> = {}) {
  const r = renderKb({ world: docWorld(), bridge });
  const rail = await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.click(within(rail).getByRole('button', { name: /^Wiki/ }));
  act(() => r.services.ui.getState().openDocument({ type: 'page', id }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  await within(doc).findByRole('heading', { level: 2 });
  return { ...r, doc };
}

const pageAction = async (doc: HTMLElement, name: string | RegExp) => {
  fireEvent.click(within(doc).getByRole('button', { name: 'Page actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name }));
};

describe('Page ⋯: Rename, Delete, Show in Finder (B20)', () => {
  it('Rename: a taken name is refused in the field; a new one renames the page and its links follow', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openPage('g-ce');
    await pageAction(doc, 'Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename page' });
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    expect(field).toHaveValue('Cross-entropy');
    await user.clear(field);
    await user.type(field, 'Entropy');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByText('A page with this name already exists here. Choose another name.')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'Cross entropy loss');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename page' })).not.toBeInTheDocument());
    expect(within(doc).getByRole('heading', { level: 2 })).toHaveTextContent('Cross entropy loss');
    expect(fake.calls.filter((c) => c.method === 'PATCH' && c.path === '/kb/wiki/pages/g-ce')).toHaveLength(2);
    // The wiki panel list follows.
    await user.click(screen.getByRole('button', { name: /^Concepts/ }));
    expect(await screen.findByRole('button', { name: /Cross entropy loss/ })).toBeInTheDocument();
  });

  it('Delete: a preview first (links unlinked, own notes, sources kept); Cancel changes nothing; Delete closes the page', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openPage('g-ce');
    await pageAction(doc, 'Delete page…');
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Cross-entropy”?' });
    expect(await within(dialog).findByText(/to this page (is|are) removed; the words stay\.|No other page links here\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/stays? in the library|No materials are touched/)).toBeInTheDocument();
    expect(fake.calls.some((c) => c.method === 'GET' && c.path === '/kb/wiki/pages/g-ce/delete-preview')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await pageAction(doc, 'Delete page…');
    const again = await screen.findByRole('dialog', { name: 'Delete “Cross-entropy”?' });
    await user.click(await within(again).findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Document' })).not.toBeInTheDocument());
    expect(fake.world.pages.some((p) => p.id === 'g-ce')).toBe(false);
  });

  it('Show in Finder asks main for the page by id only and says when Finder couldn’t', async () => {
    const showInFinder = vi.fn(async () => true);
    const { doc } = await openPage('p-entropy', { showInFinder });
    await pageAction(doc, 'Show in Finder');
    expect(showInFinder).toHaveBeenCalledWith({ kind: 'page', id: 'p-entropy' });
    showInFinder.mockResolvedValueOnce(false);
    await pageAction(doc, 'Show in Finder');
    expect(await within(doc).findByRole('alert')).toHaveTextContent('Finder couldn’t show this page.');
  });

  it('without the desktop bridge there is no Show in Finder', async () => {
    const { doc } = await openPage('p-entropy');
    fireEvent.click(within(doc).getByRole('button', { name: 'Page actions' }));
    await screen.findByRole('menuitem', { name: 'Rename' });
    expect(screen.queryByRole('menuitem', { name: 'Show in Finder' })).not.toBeInTheDocument();
  });
});
