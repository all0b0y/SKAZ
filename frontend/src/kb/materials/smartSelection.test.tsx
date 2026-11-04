import { describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';

// Selection is local UI state: these checks use the renderer's existing bridge seam, not a real model.
describe('Material smart selections use actual metadata', () => {
  it('This week means the current Monday-based calendar week, not the last seven days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 28, 12));
    try {
      const user = userEvent.setup();
      const world = docWorld();
      for (const material of world.materials) material.created_at = new Date(2026, 9, 23, 12).toISOString();
      const eligible = world.materials.filter((m) => m.status !== 'recording' && m.wiki_state !== 'processing');
      eligible[0]!.created_at = new Date(2026, 9, 26, 0).toISOString();
      eligible[1]!.created_at = new Date(2026, 9, 28, 11).toISOString();
      renderKb({ world, prefs: { section: 'materials' } });
      await user.click(await screen.findByTestId('all-materials'));
      const center = await screen.findByRole('region', { name: 'All materials' });
      await within(center).findByRole('grid');
      await user.click(within(center).getByRole('button', { name: 'Select items' }));
      await user.click(await screen.findByRole('menuitem', { name: /^This week/ }));
      const selected = [...center.querySelectorAll('[data-sel-id][aria-selected="true"]')].map((r) => r.getAttribute('data-sel-id'));
      expect(new Set(selected)).toEqual(new Set([eligible[0]!.id, eligible[1]!.id]));
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});
