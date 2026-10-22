import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld, docWorld } from '../test/fixtures';
import { materialWiki } from '../test/fakeKb';

// C1-d (user decisions 14 and 15, 2026-10-20): a material that reached its wiki budget is paused,
// not failed — "Paused · budget reached" with Continue, and nothing about it is claimed as done.
// The budget is a setting in Settings → Models (Wiki), shown in human units.

const REASON = 'Paused: this material used its wiki budget of 2M characters. The finished work is kept; '
  + 'Continue picks up from it with another 2M.';

describe('A material paused at its wiki budget', () => {
  it('says so and offers Continue, which picks the work up again', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    const job = world.jobs.find((j) => j.material_id === 'm-l5')!;
    Object.assign(job, { state: 'paused', step: 'writing_notes', label: 'Paused · budget reached', error: REASON,
      error_code: 'BUDGET_REACHED', can_retry: false, step_started_at: null });
    const m = world.materials.find((x) => x.id === 'm-l5')!;
    m.wiki = materialWiki('paused', { job_id: job.id, error: REASON, error_code: 'BUDGET_REACHED' });
    m.wiki_state = 'paused';
    const r = renderKb({ world });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-l5' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    const strip = await within(doc).findByLabelText('Processing');
    expect(within(strip).getByText('Paused · budget reached')).toBeInTheDocument();
    expect(within(strip).getByText(REASON)).toBeInTheDocument();
    // Never shown as a failure, and no "Writing notes" spinner for a job that isn't running.
    expect(within(strip).queryByText(/Couldn’t add to the wiki|^Wiki:/)).toBeNull();
    expect(within(strip).queryByText(/^Writing notes/)).toBeNull();
    await user.click(within(strip).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(r.fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/materials/m-l5/ingest',
    })));
  });
});

async function openModels() {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Models/ }));
  return dialog;
}

describe('Wiki budget per material', () => {
  it('shows the budget in human units in the Wiki group and saves a new value', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.wiki = { ...world.wiki, wiki_budget_characters: 2_000_000 };
    const { fake } = renderKb({ world });
    const dialog = await openModels();
    const row = within(dialog).getByRole('group', { name: 'Wiki budget per material' });
    expect(row.closest('.kb-sgroup')?.querySelector('.kb-sgroup__title')?.textContent).toBe('Wiki');
    expect(within(row).getByText('2M characters')).toBeInTheDocument();
    const input = within(row).getByRole('spinbutton', { name: 'Wiki budget per material, millions of characters' });
    await user.clear(input);
    await user.type(input, '1.2{Enter}');
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/settings/wiki', body: { wiki_budget_characters: 1_200_000 },
    })));
    expect(await within(row).findByText('1.2M characters')).toBeInTheDocument();
  });

  it('refuses a value outside the allowed range without sending it', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.wiki = { ...world.wiki, wiki_budget_characters: 2_000_000 };
    const { fake } = renderKb({ world });
    const dialog = await openModels();
    const row = within(dialog).getByRole('group', { name: 'Wiki budget per material' });
    const input = within(row).getByRole('spinbutton', { name: 'Wiki budget per material, millions of characters' });
    await user.clear(input);
    await user.type(input, '0{Enter}');
    expect(await within(row).findByRole('alert')).toHaveTextContent('From 0.01 to 1000 million characters.');
    expect(fake.calls.filter((c) => c.method === 'PUT' && c.path === '/kb/settings/wiki')).toHaveLength(0);
  });
});
