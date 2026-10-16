import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';

const openModels = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Models/ }));
  return within(dialog).getByRole('group', { name: 'Recognition check' });
};

async function openMaterial(id: string, world = docWorld()) {
  const r = renderKb({ world });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type: 'material', id }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  await within(doc).findByRole('heading', { level: 2 });
  return { ...r, doc };
}

describe('Settings → Models → Recognition check (B20)', () => {
  it('same as wiki pages by default; an agent with its own model and effort; Off', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: docWorld() });
    const row = await openModels();
    expect(await within(row).findByRole('radio', { name: 'Same as wiki pages' })).toHaveAttribute('aria-checked', 'true');
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();

    await user.click(within(row).getByRole('radio', { name: 'Codex' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/recognition', body: { engine: 'codex', model: null, effort: null } })));
    const model = await within(row).findByRole('combobox', { name: 'Model for the recognition check' });
    await user.selectOptions(model, 'gpt-5.6-luna-mini');
    await waitFor(() => expect(fake.world.recognition).toEqual({ engine: 'codex', model: 'gpt-5.6-luna-mini', effort: null }));
    await user.selectOptions(await within(row).findByRole('combobox', { name: 'Effort for the recognition check' }), 'high');
    await waitFor(() => expect(fake.world.recognition).toEqual({ engine: 'codex', model: 'gpt-5.6-luna-mini', effort: 'high' }));

    // An agent that isn't connected is refused here, never saved.
    await user.click(within(row).getByRole('radio', { name: 'Hermes' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Hermes Agent isn’t connected');
    expect(fake.world.recognition?.engine).toBe('codex');

    await user.click(within(row).getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(fake.world.recognition).toEqual({ engine: 'off', model: null, effort: null }));
    expect(within(row).getByText('Recordings go to the wiki as recognised.')).toBeInTheDocument();
  });
});

describe('Recording ⋯ → Check recognition again (B20)', () => {
  it('starts the backend job and shows its step on the material', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openMaterial('m-lec8');
    await user.click(within(doc).getByRole('button', { name: 'Material actions' }));
    const item = await screen.findByRole('menuitem', { name: /Check recognition again/ });
    await waitFor(() => expect(item).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(item);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/materials/m-lec8/recognition-check' })));
    expect(await within(doc).findByText('Checking recognition')).toBeInTheDocument();
  });

  it('disabled with the reason when the check is off; absent for text', async () => {
    const world = docWorld();
    world.recognition = { engine: 'off', model: null, effort: null };
    const user = userEvent.setup();
    const { doc, services } = await openMaterial('m-lec8', world);
    await user.click(within(doc).getByRole('button', { name: 'Material actions' }));
    const item = await screen.findByRole('menuitem', { name: /Check recognition again/ });
    await waitFor(() => expect(item).toHaveAttribute('aria-disabled', 'true'));
    expect(item).toHaveTextContent('Check is off in Settings');
    fireEvent.keyDown(item, { key: 'Escape' });

    act(() => services.ui.getState().openDocument({ type: 'material', id: 'm-txt' }));
    await within(doc).findByRole('heading', { level: 2, name: 'Pasted text: problems' });
    await user.click(within(doc).getByRole('button', { name: 'Material actions' }));
    await screen.findByRole('menuitem', { name: /Rename/ });
    expect(screen.queryByRole('menuitem', { name: /Check recognition again/ })).not.toBeInTheDocument();
  });
});
