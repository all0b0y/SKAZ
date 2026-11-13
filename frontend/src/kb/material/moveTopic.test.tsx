import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import { children, mapFixture, roots } from '../explore/test/fixtures';

afterEach(cleanup);
async function openMove(failure = false) {
  const r = renderKb({ world: docWorld() });
  const original = r.fake.requestMock.getMockImplementation()!;
  r.fake.requestMock.mockImplementation(async (request) => {
    if (request.path === '/kb/explore/map') return { ok: true, status: 200, data: request.query?.parent_id === 'ai'
      ? mapFixture({ parent_id: 'ai', breadcrumbs: [roots[0]!], areas: children }) : mapFixture() };
    if (request.path.endsWith('/topic') && request.method === 'PUT') return failure
      ? { ok: false, status: 503, detail: 'sensitive provider detail', code: 'not_ready' }
      : { ok: true, status: 200, data: { material_id: 'm-txt', area_id: 'agents', origin: 'user' } };
    return original(request);
  });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-txt' }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  await within(doc).findByRole('heading', { level: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Material actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Topic ▸' }));
  return { ...r, dialog: await screen.findByRole('dialog', { name: 'Move to topic' }) };
}

describe('EX2 Move to topic', () => {
  it('searches topics and creates a nonempty topic inside an existing top-level topic atomically', async () => {
    const { dialog, fake } = await openMove();
    await within(dialog).findByRole('option', { name: 'AI agents › Agent harnesses' });
    const original = fake.requestMock.getMockImplementation()!;
    fake.requestMock.mockImplementation(async (request) => request.path.endsWith('/new-topic')
      ? { ok: true, status: 200, data: { material_id: 'm-txt', area_id: 'new', origin: 'user' } } : original(request));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search topics' }), { target: { value: 'Agent harnesses' } });
    expect(within(dialog).queryByRole('option', { name: 'Learning' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'New topic…' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Local tools' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Inside' }), { target: { value: 'ai' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create topic' }));
    await waitFor(() => expect(fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/kb/materials/m-txt/new-topic', body: { name: 'Local tools', parent_id: 'ai' },
    })));
    expect(fake.calls.some((c) => c.path === '/kb/explore/areas' && c.method === 'POST')).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Move to topic' })).not.toBeInTheDocument());
  });

  it('chooses any depth of own topics and sends only the material id and chosen topic id on Move', async () => {
    const { dialog, fake } = await openMove();
    await within(dialog).findByRole('option', { name: 'AI agents › Agent harnesses' });
    expect(fake.calls.filter((call) => call.path.endsWith('/topic'))).toHaveLength(0);
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Destination topic' }), { target: { value: 'agents' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'PUT', path: '/kb/materials/m-txt/topic', body: { area_id: 'agents' } })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Move to topic' })).not.toBeInTheDocument());
    expect(await screen.findByText('Moved to AI agents › Agent harnesses.')).toBeInTheDocument();
  });

  it('leaves the picker open on not_ready and never displays backend detail', async () => {
    const { dialog } = await openMove(true);
    await within(dialog).findByRole('option', { name: 'AI agents › Agent harnesses' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Destination topic' }), { target: { value: 'agents' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not ready');
    expect(within(dialog).getByRole('combobox', { name: 'Destination topic' })).toHaveValue('agents');
    expect(screen.queryByText('sensitive provider detail')).not.toBeInTheDocument();
  });
});
