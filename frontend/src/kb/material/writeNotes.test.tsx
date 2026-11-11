import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import { materialWiki } from '../test/fakeKb';

describe('WR6 explicit Notes', () => {
  it('Wiki settings defaults to off and saves Write notes automatically', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: docWorld() });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const settings = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(settings).getByRole('button', { name: 'Wiki' }));
    const toggle = await within(settings).findByRole('switch', { name: 'Write notes automatically' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(fake.calls.some((c) => c.path === '/kb/settings/wiki' && c.method === 'PUT'
      && (c.body as Record<string, unknown>).write_notes_automatically === true)).toBe(true);
  });

  it('a material without Notes offers Write notes and queues that action only once', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    const material = world.materials.find((m) => m.id === 'm-lec8')!;
    material.wiki = materialWiki('in_wiki', { concept_count: 14, note_page_id: null });
    world.jobs = world.jobs.filter((j) => j.material_id !== material.id);
    const { services, fake } = renderKb({ world });
    act(() => services.ui.getState().openDocument({ type: 'material', id: material.id }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    const write = await within(doc).findByRole('button', { name: 'Write notes' });
    await user.click(write);
    await waitFor(() => expect(fake.calls.filter((c) => c.path === `/kb/materials/${material.id}/notes`)).toHaveLength(1));
    expect(fake.calls.some((c) => c.method === 'POST' && c.path.endsWith('/ingest'))).toBe(false);
    await waitFor(() => expect(within(doc).queryByRole('button', { name: 'Write notes' })).not.toBeInTheDocument());
    expect(await within(doc).findByText(/Writing notes/)).toBeInTheDocument();
  });

  it('existing Notes keep their open action without offering another Notes run', async () => {
    const { services } = renderKb({ world: docWorld() });
    act(() => services.ui.getState().openDocument({ type: 'material', id: 'm-lec8' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    await within(doc).findByRole('button', { name: 'Open the notes' });
    expect(within(doc).queryByRole('button', { name: 'Write notes' })).not.toBeInTheDocument();
  });

  it('a failed Notes attempt shows its reason and can retry despite an older budget pause', async () => {
    const world = docWorld();
    const material = world.materials.find((m) => m.id === 'm-lec8')!;
    material.wiki = materialWiki('in_wiki', { concept_count: 14, note_page_id: null,
      error: 'The Notes answer stopped. Retry continues from the finished sections.' });
    const oldPause = world.jobs.find((j) => j.material_id === 'm-l5')!;
    Object.assign(oldPause, { material_id: material.id, state: 'paused', error_code: 'BUDGET_REACHED' });
    const { services } = renderKb({ world });
    act(() => services.ui.getState().openDocument({ type: 'material', id: material.id }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    expect(await within(doc).findByRole('button', { name: 'Write notes' })).toBeEnabled();
    expect(within(doc).getByRole('alert')).toHaveTextContent('The Notes answer stopped.');
  });
});
