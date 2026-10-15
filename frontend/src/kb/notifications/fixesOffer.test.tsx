import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbNotification } from '../../api/kb/types.gen';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { kindOf } from './kinds';

/** What `corrections/offer.py` posts at the first finished recording (user decision X2-8). */
const OFFER: KbNotification = {
  id: 'n-offer', kind: 'auto_fixes_offer', title: 'Turn on automatic fixes',
  body: 'Download a 2.7 GB local model so SKAZ can fix misheard words in recordings by itself.',
  payload: { bytes: 2_740_937_888 }, requires_action: true, created_at: new Date().toISOString(),
  dismissed_at: null, seq: 8, subject: null, resolved_at: null, resolution: null,
  actions: [
    { id: 'download', label: 'Download', primary: true, needs_text: false },
    { id: 'not_now', label: 'Not now', primary: false, needs_text: false },
  ],
};

function offerWorld() {
  const world = chatWorld();
  world.notifications = [OFFER, ...world.notifications];
  world.notificationSeq = 8;
  return world;
}

const openFeed = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /^Notifications/ }));
  return screen.findByRole('region', { name: 'Notifications' });
};

describe('Automatic fixes offer', () => {
  it('has its own icon, not the generic bell', () => {
    expect(kindOf(OFFER).icon).toBe('fixes');
  });

  it('Download decides in place from the feed', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: offerWorld() });
    const feed = await openFeed(user);
    const row = (await within(feed).findByText('Turn on automatic fixes')).closest('li') as HTMLElement;
    expect(row).toHaveTextContent('2.7 GB');
    await user.click(within(row).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      path: '/kb/notifications/n-offer/resolve', body: { action: 'download', text: null },
    })));
  });

  it('Not now is sent from the decision window', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: offerWorld() });
    const feed = await openFeed(user);
    await user.click(await within(feed).findByRole('button', { name: 'Needs a decision: Turn on automatic fixes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn on automatic fixes' });
    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      path: '/kb/notifications/n-offer/resolve', body: { action: 'not_now', text: null },
    })));
  });
});
