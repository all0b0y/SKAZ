import { describe, expect, it } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';

// C1-f (decided 2026-10-20): while the agent writes, the material shows real progress — which part,
// how many sections are done, and for how long — instead of a bare "Writing notes" for 12 minutes.

describe('Live progress of the wiki notes', () => {
  it('shows the part, the sections written and the time since the step began', async () => {
    const world = docWorld();
    const job = world.jobs[0]!;
    Object.assign(job, {
      label: 'Writing notes · part 3 of 4 · 14 sections',
      step_started_at: new Date(Date.now() - 200_000).toISOString(),
      progress: { ...job.progress, notes_sections: 14 },
    });
    const r = renderKb({ world });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-l5' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    const strip = await within(doc).findByLabelText('Processing');
    expect(await within(strip).findByText(/^Writing notes · part 3 of 4 · 14 sections · 3:2\d$/)).toBeInTheDocument();
  });

  it('without a start time it shows the backend’s line as is', async () => {
    const world = docWorld();
    Object.assign(world.jobs[0]!, { label: 'Writing notes · part 1 of 2', step_started_at: null });
    const r = renderKb({ world });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-l5' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    expect(await within(doc).findByText('Writing notes · part 1 of 2')).toBeInTheDocument();
  });
});
