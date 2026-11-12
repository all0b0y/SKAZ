import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import { materialWiki } from '../test/fakeKb';
import { contractFixtures } from '../api/fake/fixtures';
import { mapFixture } from '../explore/test/fixtures';

afterEach(cleanup);

it('keeps the explicit unused snapshot and exposes the repeat check from Materials', async () => {
  const r = renderKb({ world: docWorld(), prefs: { section: 'materials' } });
  const original = r.fake.requestMock.getMockImplementation()!;
  let kept = false;
  r.fake.requestMock.mockImplementation(async (request) => {
    if (request.path === '/kb/materials-activity/explore-unused') return { ok: true, status: 200, data: { material_ids: kept ? [] : ['m-txt'] } };
    if (request.path.endsWith('/explore-unused/keep')) { kept = true; return { ok: true, status: 200, data: { ok: true } }; }
    return original(request);
  });
  await screen.findByTestId('all-materials');
  fireEvent.click(screen.getByTestId('all-materials'));
  const center = await screen.findByRole('region', { name: 'All materials' });
  expect(await within(center).findByText('1 paper from Explore unused for 30 days')).toBeInTheDocument();
  expect(r.fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  fireEvent.click(within(center).getByRole('button', { name: 'Keep' }));
  await waitFor(() => expect(r.fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({ path: '/kb/materials-activity/explore-unused/keep', body: { material_ids: ['m-txt'] } })));
  await waitFor(() => expect(within(center).queryByRole('button', { name: 'Keep' })).not.toBeInTheDocument());
  fireEvent.click(within(center).getByRole('button', { name: 'Check older materials' }));
  expect(await screen.findByRole('dialog', { name: 'Check older materials' })).toBeInTheDocument();
});

it('removes only the clicked snapshot after rechecking eligibility, leaving new arrivals alone', async () => {
  const r = renderKb({ world: docWorld(), prefs: { section: 'materials' } });
  const original = r.fake.requestMock.getMockImplementation()!;
  let reads = 0;
  r.fake.requestMock.mockImplementation(async (request) => {
    if (request.path === '/kb/materials-activity/explore-unused') return { ok: true, status: 200,
      data: { material_ids: ++reads === 1 ? ['m-txt'] : ['m-txt', 'm-pdf'] } };
    return original(request);
  });
  await screen.findByTestId('all-materials');
  fireEvent.click(screen.getByTestId('all-materials'));
  const center = await screen.findByRole('region', { name: 'All materials' });
  await within(center).findByText('1 paper from Explore unused for 30 days');
  expect(r.fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
  fireEvent.click(within(center).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(r.fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', path: '/kb/materials/m-txt' })));
  expect(r.fake.calls.some((c) => c.method === 'DELETE' && c.path === '/kb/materials/m-pdf')).toBe(false);
});

it('records an opening once for the document, independently of material polling', async () => {
  const r = renderKb({ world: docWorld() });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-txt' }));
  await waitFor(() => expect(r.fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/kb/materials/m-txt/opened' })));
});

it('orders From Explore after Inbox and uses the shared Add to wiki action without opening the row', async () => {
  const world = docWorld();
  const inbox = world.folders.find((f) => f.name === 'Inbox')!;
  for (const material of world.materials) if (material.folder_id === inbox.id) material.folder_id = 'fld-inbox';
  inbox.id = 'fld-inbox';
  world.folders.unshift({ ...world.folders[0]!, id: 'fld-explore', name: 'From Explore', system: true, material_count: 1 });
  const paper = world.materials.find((m) => m.id === 'm-txt')!;
  paper.folder_id = 'fld-explore'; paper.wiki = materialWiki('not_in_wiki');
  const r = renderKb({ world, prefs: { section: 'materials' } });
  await screen.findByTestId('all-materials');
  fireEvent.click(screen.getByTestId('all-materials'));
  const center = await screen.findByRole('region', { name: 'All materials' });
  const row = (await within(center).findByRole('button', { name: paper.title })).closest('tr')!;
  expect(within(row).getByText('Not in wiki')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: 'Add to wiki' }));
  await waitFor(() => expect(r.fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/kb/materials/m-txt/ingest' })));
  expect(r.services.ui.getState().docMaterialId).not.toBe('m-txt');
  const folderOptions = within(center).getByRole('combobox', { name: 'Folder' }).querySelectorAll('option');
  expect([...folderOptions].slice(1, 3).map((o) => o.value)).toEqual(['fld-inbox', 'fld-explore']);
});

it('starts the existing topic repeat check and resumes using the latest checkpoint', async () => {
  const r = renderKb({ world: docWorld(), prefs: { section: 'materials' } });
  const original = r.fake.requestMock.getMockImplementation()!;
  const job = { ...contractFixtures.KbRepeatCheck, id: 'repeat-1', area_id: 'ai', state: 'paused' as const, stop_reason: 'user_pause' as const };
  const checkpoint = { ...contractFixtures.KbRepeatCheck.checkpoint!, id: 'fresh', revision: 9 };
  r.fake.requestMock.mockImplementation(async (request) => {
    if (request.path === '/kb/explore/map') return { ok: true, status: 200, data: mapFixture({ areas: [mapFixture().areas[1]!] }) };
    if (request.path === '/kb/explore/repeat-checks') return { ok: true, status: 200, data: job };
    if (request.path === '/kb/explore/repeat-checks/repeat-1') return { ok: true, status: 200, data: { ...job, checkpoint } };
    if (request.path.endsWith('/continue')) return { ok: true, status: 200, data: { ...job, state: 'done' } };
    return original(request);
  });
  await screen.findByTestId('all-materials');
  fireEvent.click(screen.getByTestId('all-materials'));
  const center = await screen.findByRole('region', { name: 'All materials' });
  fireEvent.click(within(center).getByRole('button', { name: 'Check older materials' }));
  const dialog = await screen.findByRole('dialog', { name: 'Check older materials' });
  await within(dialog).findByRole('option', { name: 'ML' });
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Topic to check' }), { target: { value: 'ml' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check' }));
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(r.fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({
    path: '/kb/explore/repeat-checks/repeat-1/continue', body: { checkpoint_id: 'fresh', revision: 9 },
  })));
  expect(await within(dialog).findByRole('status')).toHaveTextContent('Repeat check complete.');
});
