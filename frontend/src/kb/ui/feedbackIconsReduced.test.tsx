import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { docWorld } from '../test/fakeBridge';
import { iconPlays } from '../test/iconPlays';
import type { CaptureEngine } from '../recording/capture';

// prefers-reduced-motion: reduce — set before Motion first reads it (this file only). Nothing plays; the actions still work.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query.includes('prefers-reduced-motion'),
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
}));
vi.mock('@animateicons/react/lucide/arrow-up-icon', async (load) => ({
  ArrowUpIcon: (await import('../test/iconPlays')).spyOnIcon('send', (await load<typeof import('@animateicons/react/lucide/arrow-up-icon')>()).ArrowUpIcon),
}));
vi.mock('@animateicons/react/lucide/square-pen-icon', async (load) => ({
  SquarePenIcon: (await import('../test/iconPlays')).spyOnIcon('newChat', (await load<typeof import('@animateicons/react/lucide/square-pen-icon')>()).SquarePenIcon),
}));
vi.mock('@animateicons/react/lucide/check-icon', async (load) => ({
  CheckIcon: (await import('../test/iconPlays')).spyOnIcon('check', (await load<typeof import('@animateicons/react/lucide/check-icon')>()).CheckIcon),
}));
vi.mock('@animateicons/react/huge/notification-icon', async (load) => ({
  NotificationIcon: (await import('../test/iconPlays')).spyOnIcon('bell', (await load<typeof import('@animateicons/react/huge/notification-icon')>()).NotificationIcon),
}));
vi.mock('@animateicons/react/huge/mic-0-1-icon', async (load) => ({
  Mic01Icon: (await import('../test/iconPlays')).spyOnIcon('mic', (await load<typeof import('@animateicons/react/huge/mic-0-1-icon')>()).Mic01Icon),
}));
vi.mock('@animateicons/react/huge/refresh-0-1-icon', async (load) => ({
  Refresh01Icon: (await import('../test/iconPlays')).spyOnIcon('retry', (await load<typeof import('@animateicons/react/huge/refresh-0-1-icon')>()).Refresh01Icon),
}));

const side = () => screen.getByRole('region', { name: 'Chats' });
beforeEach(() => { iconPlays.length = 0; });

describe('Feedback motion with reduced motion', () => {
  it('copy, regenerate, resend and send do their work and play nothing', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const answer = await within(centre).findByRole('article', { name: 'Answer' });
    await user.click(within(answer).getByRole('button', { name: 'Copy' }));
    expect(await within(answer).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await user.click(within(answer).getByRole('button', { name: 'Regenerate' }));
    const question = within(centre).getAllByRole('article', { name: 'Your question' })[0]!;
    await user.click(within(question).getByRole('button', { name: 'Resend' }));
    await waitFor(() => expect(within(centre).getAllByRole('article', { name: 'Your question' }).length).toBeGreaterThan(1));
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('One more{Enter}');
    await waitFor(() => expect(within(centre).getAllByRole('article', { name: 'Your question' }).length).toBeGreaterThan(2));
    expect(iconPlays).toEqual([]);
  });

  it('new chat plays nothing', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: 'New chat' }));
    expect(iconPlays).toEqual([]);
  });

  it('a new unread notification does not move the bell', async () => {
    const r = renderKb();
    const bell = await screen.findByRole('button', { name: /^Notifications/ });
    await waitFor(() => expect(bell).toHaveAccessibleName('Notifications, 1 unread'));
    act(() => { r.services.notifications.setState({ unread: 4 }); });
    expect(bell).toHaveAccessibleName('Notifications, 4 unread');
    expect(iconPlays).toEqual([]);
  });

  it('record: the mic does not move and the starting spinner takes its place at once', async () => {
    const user = userEvent.setup();
    const stuck: CaptureEngine = {
      start: vi.fn(() => new Promise<void>(() => undefined)), pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined),
      stop: vi.fn(async () => true), elapsedMs: () => 0, pending: () => ({ pending: 0, failed: 0 }),
    };
    renderKb({ world: docWorld(), capture: () => stuck });
    const record = await within(screen.getByTestId('titlebar')).findByRole('button', { name: 'Record' });
    await waitFor(() => expect(record).not.toHaveAttribute('aria-disabled'));
    await user.click(record);
    await waitFor(() => expect(record.querySelector('.kb-spinner')).toBeInTheDocument());
    expect(record.querySelector('[data-icon="mic"]')).not.toBeInTheDocument();
    expect(iconPlays).toEqual([]);
  });
});
