import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';

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

it('records an opening once for the document, independently of material polling', async () => {
  const r = renderKb({ world: docWorld() });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-txt' }));
  await waitFor(() => expect(r.fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/kb/materials/m-txt/opened' })));
});
