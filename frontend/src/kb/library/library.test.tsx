import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbApiError, KbClient, buildPath } from '../api/client';
import { createFakeBridge } from '../test/fakeBridge';
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
    expect(fake.state.folders.map((f) => f.name)).toContain('Machine learning');
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
    fake.state.folders.push({ id: 'empty', name: 'Empty one', system: false, material_count: 0, created_at: '2026-10-14T00:00:00Z' });
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
    expect(fake.state.folders.map((f) => f.id)).not.toContain('empty');
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
      state: {
        library: { state: 'unavailable', root: '/Volumes/USB/SKAZ', suggested_root: '/Users/me/Documents/SKAZ', reason: 'The library folder is missing.', library_id: 'lib1' },
        folders: [], materials: [], notifications: [],
      },
    });
    const side = await screen.findByRole('region', { name: 'Materials' });
    const alert = await within(side).findByRole('alert');
    expect(alert).toHaveTextContent('Library folder is unavailable. The library folder is missing. Nothing was deleted.');
    expect(within(side).queryByText(/No materials/)).not.toBeInTheDocument();
  });
});
