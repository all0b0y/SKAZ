import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbApiError, KbClient, buildPath } from '../api/client';
import { baseWorld, createFakeBridge } from '../test/fakeBridge';
import { renderKb } from '../test/renderKb';

describe('KbClient over the preload bridge', () => {
  it('sends typed requests and returns the data', async () => {
    const fake = createFakeBridge();
    const client = new KbClient(fake.bridge);
    const folders = await client.folders();
    expect(folders.map((f) => f.name)).toEqual(['Inbox', 'Physics']);
    const inPhysics = await client.materials('phys');
    expect(inPhysics).toHaveLength(2);
    expect(fake.calls.at(-1)).toEqual({ method: 'GET', path: '/kb/materials', query: { folder_id: 'phys' }, body: undefined });
    await client.materials();
    expect(fake.calls.at(-1)!.query).toBeUndefined();
  });

  it('turns a refusal into KbApiError with the backend’s words', async () => {
    const client = new KbClient(createFakeBridge().bridge);
    await expect(client.createFolder('physics')).rejects.toEqual(
      new KbApiError(409, 'An item with this name already exists. Choose another name.'),
    );
  });

  it('keeps every id one encoded path segment', () => {
    expect(buildPath('/kb/folders/{folder_id}', { folder_id: 'a/b ?' })).toBe('/kb/folders/a%2Fb%20%3F');
    expect(() => buildPath('/kb/folders/{folder_id}', {})).toThrow(/folder_id/);
  });

  it('passes a material id and reads one material', async () => {
    const request = vi.fn(async () => ({ ok: true as const, status: 200, data: { id: 'm 1' } }));
    const client = new KbClient({ request: request as never });
    await client.material('m 1');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/kb/materials/m%201' }));
  });
});

describe('Library side panel on real /kb answers', () => {
  it('lists recent materials (newest first), folders with counts and "All materials · N"', async () => {
    renderKb({ prefs: { section: 'materials' } });
    const side = await screen.findByRole('region', { name: 'Materials' });
    const recent = await within(side).findByRole('list', { name: 'Recent' });
    expect(within(recent).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Pasted text: problemsInbox', 'Lecture 8 — entropy', 'Textbook: Information theory, ch. 2',
    ]);
    const folders = within(side).getByRole('list', { name: 'Folders' });
    expect(within(folders).getByRole('button', { name: /^Inbox/ })).toHaveTextContent('1');
    expect(within(folders).getByRole('button', { name: /^Physics/ })).toHaveTextContent('2');
    expect(within(side).getByTestId('all-materials')).toHaveTextContent('All materials · 3');
  });

  it('creates a folder; a name collision is shown in place in the backend’s words', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ prefs: { section: 'materials' } });
    const side = await screen.findByRole('region', { name: 'Materials' });
    await within(side).findByRole('list', { name: 'Folders' });
    await user.click(within(side).getByRole('button', { name: 'New folder' }));
    const field = within(side).getByRole('textbox', { name: 'New folder name' });
    await user.type(field, 'PHYSICS{Enter}');
    const error = await within(side).findByRole('alert');
    expect(error).toHaveTextContent('An item with this name already exists. Choose another name.');
    expect(field).toHaveValue('PHYSICS');
    expect(field).toHaveAttribute('aria-invalid', 'true');

    await user.clear(field);
    await user.type(field, 'Machine learning{Enter}');
    const folders = within(side).getByRole('list', { name: 'Folders' });
    expect(await within(folders).findByRole('button', { name: /^Machine learning/ })).toBeInTheDocument();
    expect(within(side).queryByRole('textbox', { name: 'New folder name' })).not.toBeInTheDocument();
    expect(fake.world.folders.map((f) => f.name)).toContain('Machine learning');
  });

  it('renames a folder from its menu; Inbox has no menu', async () => {
    const user = userEvent.setup();
    renderKb({ prefs: { section: 'materials' } });
    const side = await screen.findByRole('region', { name: 'Materials' });
    await within(side).findByRole('list', { name: 'Folders' });
    expect(within(side).queryByRole('button', { name: 'Folder actions: Inbox' })).not.toBeInTheDocument();
    await user.click(within(side).getByRole('button', { name: 'Folder actions: Physics' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = within(side).getByRole('textbox', { name: 'Rename folder Physics' });
    await user.clear(field);
    await user.type(field, 'Physics 2{Enter}');
    expect(await within(side).findByRole('button', { name: /^Physics 2/ })).toBeInTheDocument();
  });

  it('deletes only an empty folder; a non-empty one is marked and refused', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ prefs: { section: 'materials' } });
    fake.world.folders.push({ id: 'empty', name: 'Empty one', system: false, material_count: 0, created_at: '2026-10-14T00:00:00Z' });
    const side = await screen.findByRole('region', { name: 'Materials' });
    await within(side).findByRole('button', { name: 'Folder actions: Empty one' });

    await user.click(within(side).getByRole('button', { name: 'Folder actions: Physics' }));
    const del = await screen.findByRole('menuitem', { name: /Delete/ });
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveTextContent('Not empty');
    await user.keyboard('{Escape}');

    await user.click(within(side).getByRole('button', { name: 'Folder actions: Empty one' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(within(side).queryByRole('button', { name: /Empty one/ })).not.toBeInTheDocument());
    expect(fake.world.folders.map((f) => f.id)).not.toContain('empty');
  });

  it('opens a folder: its materials come from /kb/materials?folder_id=…', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ prefs: { section: 'materials' } });
    const side = await screen.findByRole('region', { name: 'Materials' });
    const folders = await within(side).findByRole('list', { name: 'Folders' });
    await user.click(within(folders).getByRole('button', { name: /^Physics/ }));
    const list = await within(side).findByRole('list', { name: 'Physics' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(fake.calls.some((c) => c.path === '/kb/materials' && c.query?.folder_id === 'phys')).toBe(true);
    await user.click(within(side).getByRole('button', { name: 'All folders' }));
    expect(await within(side).findByRole('list', { name: 'Folders' })).toBeInTheDocument();
  });

  it('an unavailable library is an error with the backend reason, never an empty library', async () => {
    renderKb({
      prefs: { section: 'materials' },
      world: {
        ...baseWorld(),
        library: { state: 'unavailable', root: '/Volumes/USB/SKAZ', suggested_root: '/Users/me/Documents/SKAZ', reason: 'The library folder is missing.', library_id: 'lib1' },
        folders: [], materials: [], notifications: [],
      },
    });
    const side = await screen.findByRole('region', { name: 'Materials' });
    const alert = await within(side).findByRole('alert');
    expect(alert).toHaveTextContent('Library folder is unavailable. The library folder is missing. Nothing was deleted.');
    expect(within(side).queryByText(/No materials/)).not.toBeInTheDocument();
  });

  it('says the library is indexing while the backend rescans it, then shows what the scan found', async () => {
    const world = { ...baseWorld() };
    world.library = { ...world.library, indexing: true };
    const { fake } = renderKb({ prefs: { section: 'materials' }, world });
    const side = await screen.findByRole('region', { name: 'Materials' });
    expect(await within(side).findByTestId('library-indexing')).toHaveTextContent('Indexing the library…');
    // The previous index is shown meanwhile.
    expect(await within(side).findByTestId('all-materials')).toHaveTextContent('All materials · 3');
    const reads = () => fake.calls.filter((c) => c.method === 'GET' && c.path === '/kb/library').length;
    const before = reads();
    fake.world.library = { ...fake.world.library, indexing: false };
    fake.world.materials = fake.world.materials.slice(1);
    await waitFor(() => expect(within(side).queryByTestId('library-indexing')).not.toBeInTheDocument(), { timeout: 4000 });
    expect(reads()).toBe(before + 1); // one read at a time, and none once indexing ended
    await waitFor(() => expect(within(side).getByTestId('all-materials')).toHaveTextContent('All materials · 2'));
  });
});

describe('A deleted material leaves every list (user bug 1016-1)', () => {
  const openInbox = async (user: ReturnType<typeof userEvent.setup>) => {
    const side = await screen.findByRole('region', { name: 'Materials' });
    const folders = await within(side).findByRole('list', { name: 'Folders' });
    await user.click(within(folders).getByRole('button', { name: /^Inbox/ }));
    const list = await within(side).findByRole('list', { name: 'Inbox' });
    return { side, list };
  };

  it('deleting from the material panel removes the row from the open folder and closes the panel', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ prefs: { section: 'materials' } });
    const { side, list } = await openInbox(user);
    await user.click(within(list).getByRole('button', { name: 'Pasted text: problems' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    await within(doc).findByRole('heading', { level: 2, name: 'Pasted text: problems' });
    await user.click(within(doc).getByRole('button', { name: 'Material actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const del = await screen.findByRole('dialog', { name: /Delete/ });
    await waitFor(() => expect(within(del).getByRole('button', { name: 'Delete' })).toBeEnabled());
    await user.click(within(del).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Document' })).not.toBeInTheDocument());
    await waitFor(() => expect(within(side).queryByRole('button', { name: 'Pasted text: problems' })).not.toBeInTheDocument());
    expect(services.library.getState().materials.map((m) => m.id)).not.toContain('m3');
    expect(services.library.getState().folderMaterials.map((m) => m.id)).not.toContain('m3');
    await user.click(within(side).getByRole('button', { name: 'All folders' }));
    expect(await within(side).findByTestId('all-materials')).toHaveTextContent('All materials · 2');
  });

  it('a material deleted elsewhere: opening its stale row says so and drops the row', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ prefs: { section: 'materials' } });
    const { side, list } = await openInbox(user);
    fake.world.materials = fake.world.materials.filter((m) => m.id !== 'm3');
    await user.click(within(list).getByRole('button', { name: 'Pasted text: problems' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    expect(await within(doc).findByText(/no longer in the library/)).toBeInTheDocument();
    await waitFor(() => expect(within(side).queryByRole('button', { name: 'Pasted text: problems' })).not.toBeInTheDocument());
    expect(services.library.getState().materials.map((m) => m.id)).not.toContain('m3');
  });

  it('“Delete material” in a decision removes it from the lists and closes its open panel', async () => {
    const user = userEvent.setup();
    const world = baseWorld();
    const base = world.notifications[0]!;
    world.notifications.push({
      ...structuredClone(base), id: 'n9', seq: 3, kind: 'link_failed', title: 'Couldn’t open a link', body: 'x',
      payload: { material_id: 'm3', material_title: 'Pasted text: problems', url: 'https://example.org/a', reason: 'No answer.' },
      requires_action: true, resolved_at: null, resolution: null,
      actions: [{ id: 'delete_material', label: 'Delete material', primary: false, needs_text: false }],
      subject: { type: 'material', id: 'm3', block_id: null, seg: null },
    });
    world.notificationSeq = 3;
    const { services } = renderKb({ world, prefs: { section: 'materials' } });
    const { side } = await openInbox(user);
    act(() => services.ui.getState().openDoc('m3'));
    await screen.findByRole('complementary', { name: 'Document' });
    await waitFor(() => expect(services.notifications.getState().items.some((n) => n.id === 'n9')).toBe(true));
    act(() => services.ui.getState().openDecision('n9'));
    const decision = await screen.findByRole('dialog', { name: 'Couldn’t open a link' });
    await user.click(within(decision).getByRole('button', { name: 'Delete material' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Document' })).not.toBeInTheDocument());
    await waitFor(() => expect(within(side).queryByRole('button', { name: 'Pasted text: problems' })).not.toBeInTheDocument());
    expect(services.library.getState().materials.map((m) => m.id)).not.toContain('m3');
  });
});
