import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fixtures';
import { materialWiki } from '../test/fakeKb';

async function openPaused(options: { queued?: boolean; retryAt?: string | null } = {}) {
  const world = docWorld();
  const job = world.jobs.find((j) => j.material_id === 'm-l5')!;
  Object.assign(job, { state: options.queued ? 'queued' : 'paused', step: 'writing_notes',
    label: 'Paused · usage limit reached', error: 'Codex: usage limit reached. The finished work is kept.',
    error_code: options.queued ? null : 'ENGINE_LIMIT', can_retry: false, step_started_at: null,
    engine_pause: { engine: 'codex', retry_at: options.retryAt ?? null } });
  const material = world.materials.find((m) => m.id === 'm-l5')!;
  material.wiki = materialWiki(options.queued ? 'queued' : 'paused', {
    job_id: job.id, error: job.error, error_code: job.error_code,
  });
  material.wiki_state = options.queued ? 'queued' : 'paused';
  const rendered = renderKb({ world });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => rendered.services.ui.getState().openDocument({ type: 'material', id: material.id }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  const strip = await within(doc).findByLabelText('Processing');
  return { ...rendered, strip, job };
}

describe('An engine quota pauses wiki work', () => {
  it('shows the provider reset in local time and offers Continue now and Stop', async () => {
    const at = '2026-11-11T14:30:00Z';
    const { strip } = await openPaused({ retryAt: at });
    const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(within(strip).getByText(`Codex: usage limit reached — continues at ${time}`)).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Continue now' })).toBeEnabled();
    expect(within(strip).getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(within(strip).queryByText('Paused · budget reached')).toBeNull();
    expect(within(strip).queryByText(/^Writing notes/)).toBeNull();
  });

  it('never promises an automatic reset when the engine did not report one', async () => {
    const { strip } = await openPaused();
    expect(within(strip).getByText('Codex: usage limit reached — continue manually')).toBeInTheDocument();
    expect(within(strip).queryByText(/continues at/)).toBeNull();
  });

  it('continues the selected job through its explicit Continue now endpoint', async () => {
    const user = userEvent.setup();
    const { strip, fake, job } = await openPaused();
    await user.click(within(strip).getByRole('button', { name: 'Continue now' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: `/kb/jobs/${job.id}/continue`,
    })));
    await waitFor(() => expect(within(strip).queryByRole('button', { name: 'Continue now' })).toBeNull());
  });

  it('also exposes the engine pause for a queued job and lets it be stopped', async () => {
    const user = userEvent.setup();
    const { strip, fake, job } = await openPaused({ queued: true });
    expect(within(strip).getByText('Codex: usage limit reached — continue manually')).toBeInTheDocument();
    expect(within(strip).queryByText('Queued for the wiki')).toBeNull();
    await user.click(within(strip).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: `/kb/jobs/${job.id}/cancel`,
    })));
    await waitFor(() => expect(within(strip).queryByRole('button', { name: 'Stop' })).toBeNull());
  });
});
