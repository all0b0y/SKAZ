import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';

const openStorage = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Storage/ }));
  return { dialog, row: within(dialog).getByRole('group', { name: 'Export' }) };
};

describe('Settings → Storage → Export (B20)', () => {
  it('picks a folder, follows the job’s progress, then offers Show in Finder for that folder', async () => {
    const user = userEvent.setup();
    const showInFinder = vi.fn(async () => true);
    const { fake } = renderKb({ world: docWorld(), bridge: { chooseExportFolder: vi.fn(async () => '/Users/me/Export'), showInFinder } });
    const { row } = await openStorage();
    await user.click(within(row).getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/export', body: { path: '/Users/me/Export', overwrite: false } })));
    expect(await within(row).findByRole('progressbar', { name: 'Exporting' })).toBeInTheDocument();
    const job = fake.world.jobs.find((j) => j.kind === 'export')!;
    Object.assign(job, { state: 'done', step: 'done', journal: [{ at: job.created_at, message: 'Exported 3 wiki page(s) and 2 material(s) with 5 source footnote(s).' }] });
    expect(await within(row).findByText(/Exported 3 wiki page/, undefined, { timeout: 3000 })).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Show in Finder' }));
    expect(showInFinder).toHaveBeenCalledWith({ kind: 'export', path: '/Users/me/Export' });
  });

  it('a folder inside the library is refused with the reason; nothing starts', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: docWorld(), bridge: { chooseExportFolder: vi.fn(async () => '/Users/me/Documents/SKAZ/Wiki') } });
    const { row } = await openStorage();
    await user.click(within(row).getByRole('button', { name: 'Export…' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Choose a folder outside the SKAZ library');
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/export')).toBe(false);
  });

  it('a non-empty folder only after the user confirms', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    world.exportFolders = { '/Users/me/Old export': 4 };
    const { fake } = renderKb({ world, bridge: { chooseExportFolder: vi.fn(async () => '/Users/me/Old export') } });
    const { row } = await openStorage();
    await user.click(within(row).getByRole('button', { name: 'Export…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Export into a folder that isn’t empty?' });
    expect(confirm).toHaveTextContent('“Old export” already holds 4 items.');
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/export')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Export here' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/export', body: { path: '/Users/me/Old export', overwrite: true } })));
  });

  it('the finished-export notification opens its folder', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    world.notificationSeq += 1;
    world.notifications.push({
      id: 'n-export', seq: world.notificationSeq, kind: 'export_done', title: 'Export finished',
      body: '3 wiki page(s) and 2 material(s) are in “Export”.', created_at: new Date().toISOString(), dismissed_at: null,
      requires_action: false, resolved_at: null, resolution: null, subject: null, actions: [],
      payload: { path: '/Users/me/Export', pages: 3, materials: 2 },
    });
    const showInFinder = vi.fn(async () => true);
    renderKb({ world, bridge: { showInFinder } });
    await user.click(await screen.findByRole('button', { name: /^Notifications/ }));
    const feed = await screen.findByRole('region', { name: 'Notifications' });
    const button = await within(feed).findByRole('button', { name: 'Show in Finder' });
    await user.click(button);
    expect(showInFinder).toHaveBeenCalledWith({ kind: 'export', path: '/Users/me/Export' });
  });
});
