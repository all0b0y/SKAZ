import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    // A grid since 0.3.1 F4: recent materials can be selected (aria-multiselectable).
    const recent = await within(side).findByRole('grid', { name: 'Recent' });
    expect(within(recent).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Pasted text: problemsInbox', 'Lecture 8 — entropy', 'Textbook: Information theory, ch. 2',
    ]);
    const folders = within(side).getByRole('list', { name: 'Folders' });
    expect(within(folders).getByRole('button', { name: /^Inbox/ })).toHaveTextContent('1');
    expect(within(folders).getByLabelText('1 material')).toBeInTheDocument(); // QA B35: not "1 materials"
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
    const list = await within(side).findByRole('grid', { name: 'Physics' }); // grid since 0.3.1 F4 (selectable rows)
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
    const list = await within(side).findByRole('grid', { name: 'Inbox' }); // grid since 0.3.1 F4 (selectable rows)
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

/** A DataTransfer for jsdom drags: data by type, `types`, and dropped files. */
function dataTransfer(files: File[] = []) {
  const data = new Map<string, string>();
  return {
    setData: (k: string, v: string) => { data.set(k, v); },
    getData: (k: string) => data.get(k) ?? '',
    get types() { return [...data.keys(), ...(files.length ? ['Files'] : [])]; },
    files,
    effectAllowed: 'all',
    dropEffect: 'none',
  };
}

describe('Selecting and dragging materials in the side panel (0.3.1 F3/F4)', () => {
  async function side(world = baseWorld(), bridge = {}) {
    const user = userEvent.setup();
    const r = renderKb({ prefs: { section: 'materials' }, world, bridge });
    const panel = await screen.findByRole('region', { name: 'Materials' });
    const recent = await within(panel).findByRole('grid', { name: 'Recent' });
    const rowOf = (name: string) => within(recent).getByRole('button', { name: new RegExp(`^${name}`) }).closest('[role="row"]') as HTMLElement;
    const folderRow = (name: string) => within(within(panel).getByRole('list', { name: 'Folders' })).getByRole('button', { name: new RegExp(`^${name}`) });
    return { ...r, user, panel, recent, rowOf, folderRow };
  }

  it('⌘-click selects; the compact bar moves them, a material already there is not moved again', async () => {
    const { user, rowOf, fake, panel } = await side();
    await user.keyboard('{Meta>}');
    await user.click(within(rowOf('Pasted text')).getByRole('button'));
    await user.click(within(rowOf('Lecture 8')).getByRole('button'));
    await user.keyboard('{/Meta}');
    const bar = within(panel).getByRole('toolbar', { name: '2 selected' });
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(
      ['Move to…', 'Ask in chat', 'More actions', 'Delete', 'Clear selection'],
    );
    await user.click(within(bar).getByRole('button', { name: 'Move to…' }));
    await user.click(await screen.findByRole('menuitem', { name: /Physics/ }));
    expect(await screen.findByTestId('toast')).toHaveTextContent('Moved 1 material to «Physics»');
    expect(fake.calls.filter((c) => c.method === 'PATCH').map((c) => c.path)).toEqual(['/kb/materials/m3']);
  });

  it('dragging a row onto a folder moves it, outlines the folder, Undo brings it back; the same folder says so', async () => {
    const { rowOf, folderRow, fake, user } = await side();
    const dt = dataTransfer();
    fireEvent.dragStart(rowOf('Pasted text'), { dataTransfer: dt });
    expect(JSON.parse(dt.getData('application/x-skaz-items'))).toEqual([{ type: 'material', id: 'm3' }]);
    fireEvent.dragOver(folderRow('Physics'), { dataTransfer: dt });
    expect(folderRow('Physics')).toHaveClass('is-drop');
    fireEvent.drop(folderRow('Physics'), { dataTransfer: dt });
    fireEvent.dragEnd(rowOf('Pasted text'), { dataTransfer: dt });
    expect(await screen.findByTestId('toast')).toHaveTextContent('Moved 1 material to «Physics»');
    expect(fake.world.materials.find((m) => m.id === 'm3')!.folder_id).toBe('phys');
    await waitFor(() => expect(folderRow('Physics')).toHaveTextContent('3'));
    await user.click(within(screen.getByTestId('toast')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(fake.world.materials.find((m) => m.id === 'm3')!.folder_id).toBe('inbox'));

    const again = dataTransfer();
    fireEvent.dragStart(rowOf('Lecture 8'), { dataTransfer: again });
    fireEvent.drop(folderRow('Physics'), { dataTransfer: again });
    fireEvent.dragEnd(rowOf('Lecture 8'), { dataTransfer: again });
    expect(await screen.findByText('Already in «Physics»')).toBeInTheDocument();
  });

  it('a material being recorded can’t be selected or dropped: the folder dims and the reason shows', async () => {
    const world = baseWorld();
    world.materials.find((m) => m.id === 'm3')!.status = 'recording';
    const { rowOf, folderRow, fake, panel } = await side(world);
    expect(rowOf('Pasted text').querySelector('[data-sel-box]')).toHaveAttribute('title', 'Being recorded — can’t be selected yet');
    const dt = dataTransfer();
    fireEvent.dragStart(rowOf('Pasted text'), { dataTransfer: dt });
    await waitFor(() => expect(folderRow('Physics')).toHaveClass('is-nodrop'));
    expect(within(panel).getByRole('status')).toHaveTextContent('Being recorded — can’t be moved yet');
    fireEvent.drop(folderRow('Physics'), { dataTransfer: dt });
    fireEvent.dragEnd(rowOf('Pasted text'), { dataTransfer: dt });
    expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(false);
    await waitFor(() => expect(folderRow('Physics')).not.toHaveClass('is-nodrop'));
  });

  it('files from Finder dropped on a folder open “Add material” with them and that folder', async () => {
    const droppedMediaFile = vi.fn((f: File) => ({ path: `/Users/me/Downloads/${f.name}`, name: f.name }));
    const { folderRow } = await side(baseWorld(), { droppedMediaFile });
    const dt = dataTransfer([new File(['x'], 'seminar.pdf', { type: 'application/pdf' })]);
    fireEvent.dragOver(folderRow('Physics'), { dataTransfer: dt });
    expect(folderRow('Physics')).toHaveClass('is-drop');
    fireEvent.drop(folderRow('Physics'), { dataTransfer: dt });
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    expect(dialog).toHaveTextContent('seminar.pdf');
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: /Folder/ })).toHaveValue('phys'));
  });

  it('dragging the selection onto the message field attaches it as @-mentions (F3), as ⌘↩ does', async () => {
    const { user, rowOf } = await side();
    await user.click(rowOf('Pasted text').querySelector('[data-sel-box]')!);
    await user.click(rowOf('Lecture 8').querySelector('[data-sel-box]')!);
    const composer = screen.getByTestId('composer');
    const dt = dataTransfer();
    fireEvent.dragStart(rowOf('Lecture 8'), { dataTransfer: dt });
    fireEvent.dragOver(composer, { dataTransfer: dt });
    expect(await within(composer).findByText(/Drop to attach 2 to this message/)).toBeInTheDocument();
    fireEvent.drop(composer, { dataTransfer: dt });
    fireEvent.dragEnd(rowOf('Lecture 8'), { dataTransfer: dt });
    const input = screen.getByTestId('message-input');
    await waitFor(() => expect([...input.querySelectorAll('.kb-token--mention')].map((t) => t.textContent)).toEqual(
      [expect.stringContaining('Pasted text: problems'), expect.stringContaining('Lecture 8 — entropy')],
    ));
    // ⌘↩ on the focused selection does the same.
    await user.click(rowOf('Textbook').querySelector('[data-sel-box]')!);
    within(rowOf('Textbook')).getByRole('button').focus();
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(input.querySelectorAll('.kb-token--mention')).toHaveLength(3));
  });
});

