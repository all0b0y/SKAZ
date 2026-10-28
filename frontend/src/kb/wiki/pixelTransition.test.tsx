import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';

// Stage 6 B6 PixelTransition (decision 30): only when the agent changed the page that is OPEN — the
// re-check the user asked for finished and the page read again came back different.

async function openPage(id: string, motion?: 'calm' | 'off') {
  // The Appearance knob (KbApp mirrors it onto html[data-motion]).
  const r = renderKb({ world: docWorld(), prefs: motion ? { motion } : {} });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type: 'page', id }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  return { ...r, doc };
}

/** The agent's re-check of block b5 rewrites it (the fake job finishes at once). */
function agentRewrites(fake: Awaited<ReturnType<typeof openPage>>['fake'], text: string) {
  const real = fake.requestMock.getMockImplementation()!;
  fake.requestMock.mockImplementation(async (req) => {
    const answer = await real(req);
    if (req.path.endsWith('/blocks/b5/recheck') && answer.ok) {
      // A new page object, as a real answer is: the fake otherwise hands out the very object on screen.
      const i = fake.world.pages.findIndex((p) => p.id === 'p-entropy');
      const page = fake.world.pages[i]!;
      fake.world.pages[i] = { ...page, blocks: page.blocks.map((b) => (b.id === 'b5' ? { ...b, text } : b)) };
    }
    return answer;
  });
}

async function askRecheck(doc: HTMLElement) {
  const user = userEvent.setup();
  const block = (await within(doc).findByText(/Boltzmann’s and Shannon’s formulas/)).closest('[data-block-id]') as HTMLElement;
  await user.click(within(block).getByRole('button', { name: 'Edit block' }));
  await user.click(within(block).getByRole('button', { name: /Ask the agent to re-check/ }));
}

describe('PixelTransition on the open wiki page', () => {
  it('the agent rewrote the open page: the dither cells cover the old text, the new one is revealed, then the pill', async () => {
    const { doc, fake } = await openPage('p-entropy');
    agentRewrites(fake, 'Both formulas count arrangements; the agent rewrote this after the re-check.');
    await askRecheck(doc);
    // The swap plays on the panel's stage (a canvas over the page); the old text is still there under it.
    const stage = doc.querySelector('.kb-pxstage')!;
    await waitFor(() => expect(stage).toHaveAttribute('data-px', 'cover'), { timeout: 4000 });
    expect(within(doc).getByText(/Boltzmann’s and Shannon’s formulas/)).toBeInTheDocument();
    expect(stage.querySelector('canvas.kb-pxcover')).toHaveAttribute('aria-hidden', 'true');
    expect(await within(doc).findByText(/the agent rewrote this after the re-check/)).toBeInTheDocument();
    const pill = await within(doc).findByRole('status', { name: 'Updated by the agent' });
    expect(pill).toHaveTextContent('Updated by the agent');
    await waitFor(() => expect(stage).not.toHaveAttribute('data-px'));
    expect(stage.querySelector('canvas.kb-pxcover')).toBeNull();
  });

  it('calm: a plain crossfade, no canvas; off: instant — both end with the pill', async () => {
    for (const motion of ['calm', 'off'] as const) {
      const { doc, fake, unmount } = await openPage('p-entropy', motion);
      agentRewrites(fake, `Rewritten at ${motion}.`);
      await askRecheck(doc);
      if (motion === 'calm') {
        await waitFor(() => expect(doc.querySelector('.kb-pxstage')).toHaveAttribute('data-px', 'fade-out'), { timeout: 4000 });
      }
      expect(await within(doc).findByText(`Rewritten at ${motion}.`, {}, { timeout: 4000 })).toBeInTheDocument();
      expect(await within(doc).findByRole('status', { name: 'Updated by the agent' })).toBeInTheDocument();
      expect(doc.querySelector('canvas.kb-pxcover')).toBeNull();
      unmount();
    }
  });

  it('a re-check that changed nothing, and the user\'s own edit, play nothing and show no pill', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openPage('p-entropy');
    await askRecheck(doc);
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'GET' && c.path.startsWith('/kb/jobs/'))).toBe(true), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(doc.querySelector('.kb-pxstage')).not.toHaveAttribute('data-px');
    const block = within(doc).getByText(/Boltzmann’s and Shannon’s formulas/).closest('[data-block-id]') as HTMLElement;
    await user.click(within(block).getByRole('button', { name: 'Edit block' }));
    const box = within(block).getByRole('textbox', { name: 'Block text' });
    await user.clear(box);
    await user.type(box, 'My own words.');
    await user.click(within(block).getByRole('button', { name: 'Save' }));
    expect(await within(doc).findByText('My own words.')).toBeInTheDocument();
    expect(doc.querySelector('.kb-pxstage')).not.toHaveAttribute('data-px');
    expect(within(doc).queryByRole('status', { name: 'Updated by the agent' })).toBeNull();
  });
});
