import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { docWorld } from '../test/fakeBridge';
import { iconPlays } from '../test/iconPlays';
import type { CaptureEngine } from '../recording/capture';
import { BELL_MIN_GAP_MS } from '../shell/Rail';
import { ICON_PLAY_MS } from './index';

// The six feedback buttons of the animated-icons spec (2026-10-22): each icon moves when its action happens,
// once, and never on hover. The real icons render; `iconPlays` records what was asked of them.
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

async function openC1() {
  const user = userEvent.setup();
  const r = renderKb({ world: chatWorld() });
  await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
  const centre = screen.getByRole('region', { name: 'Chat' });
  const question = (await within(centre).findAllByRole('article', { name: 'Your question' }))[0]!;
  const answer = await within(centre).findByRole('article', { name: 'Answer' });
  return { user, r, centre, question, answer };
}

beforeEach(() => { iconPlays.length = 0; });

describe('Feedback motion of the six buttons', () => {
  it('copy: the ✓ that replaces Copy draws itself once per click; hovering moves nothing', async () => {
    const { user, answer } = await openC1();
    const copy = within(answer).getByRole('button', { name: 'Copy' });
    await user.hover(copy);
    await user.hover(within(answer).getByRole('button', { name: 'Regenerate' }));
    expect(iconPlays).toEqual([]);
    await user.click(copy);
    const copied = await within(answer).findByRole('button', { name: 'Copied' });
    expect(copied.querySelector('[data-icon="check"]')).toBeInTheDocument();
    await waitFor(() => expect(iconPlays).toEqual(['check']));
    await user.click(copied); // copying again draws it again, once
    await waitFor(() => expect(iconPlays).toEqual(['check', 'check']));
  });

  it('regenerate: the arrow plays once per click, not on hover', async () => {
    const { user, answer } = await openC1();
    const regenerate = within(answer).getByRole('button', { name: 'Regenerate' });
    await user.hover(regenerate);
    expect(iconPlays).toEqual([]);
    await user.click(regenerate);
    expect(iconPlays).toEqual(['retry']);
  });

  it('your message: Copy draws the ✓, Resend plays the arrow — one each', async () => {
    const { user, question } = await openC1();
    const row = within(question).getByRole('group', { name: 'Message actions' });
    await user.click(within(row).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(iconPlays).toEqual(['check']));
    await user.click(within(row).getByRole('button', { name: 'Resend' }));
    expect(iconPlays).toEqual(['check', 'retry']);
  });

  it('a waiting Resend does nothing and does not play', async () => {
    const world = chatWorld();
    world.hold = true;
    const user = userEvent.setup();
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const question = (await within(centre).findAllByRole('article', { name: 'Your question' }))[0]!;
    await user.click(within(question).getByRole('button', { name: 'Resend' })); // starts an answer that is held
    await waitFor(() => expect(within(centre).getAllByRole('article', { name: 'Your question' })).toHaveLength(2));
    iconPlays.length = 0;
    const row = within(question).getByRole('group', { name: 'Message actions' });
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Resend' })).toHaveAttribute('aria-disabled', 'true'));
    await user.click(within(row).getByRole('button', { name: 'Resend' }));
    expect(iconPlays).toEqual([]);
  });

  it('send: the arrow plays when a message goes (Enter and the button), not for an empty field', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await within(side()).findByRole('region', { name: 'Pinned' });
    const input = screen.getByTestId('message-input');
    const send = screen.getByRole('button', { name: 'Send' });
    await user.hover(send);
    await user.click(send); // nothing typed: no message, no motion
    expect(iconPlays).toEqual([]);
    await user.click(input);
    await user.keyboard('First question{Enter}');
    await waitFor(() => expect(iconPlays).toEqual(['send']));
  });

  it('send with the button plays the arrow once', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await within(side()).findByRole('region', { name: 'Pinned' });
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('Second question');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(iconPlays).toEqual(['send']));
  });

  it('edit a question: Send in the field plays the arrow', async () => {
    const { user, question } = await openC1();
    await user.click(within(question).getByRole('button', { name: 'Edit' }));
    const field = within(question).getByRole('textbox', { name: 'Edit your question' });
    await user.click(field);
    await user.keyboard(' again');
    expect(iconPlays).toEqual([]);
    await user.click(within(question).getByRole('button', { name: 'Send' }));
    expect(iconPlays).toEqual(['send']);
  });

  it('side-panel toggle: a static glyph that shows the state (close while open, open while hidden), never animated', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const hide = await screen.findByRole('button', { name: 'Hide side panel' });
    expect(hide.querySelector('[data-icon]')).toHaveAttribute('data-icon', 'sidebarClose');
    expect(hide.querySelector('[data-icon]')).toHaveAttribute('data-set', 'lucide');
    await user.click(hide);
    const show = await screen.findByRole('button', { name: 'Show side panel' });
    expect(show.querySelector('[data-icon]')).toHaveAttribute('data-icon', 'sidebarOpen');
    expect(show.querySelector('svg[data-set="lucide"]')).not.toBeNull();
    expect(iconPlays).toEqual([]);
  });

  it('new chat: the pen plays once per click on the list entry, not on hover', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const entry = await within(side()).findByRole('button', { name: 'New chat' });
    await user.hover(entry);
    expect(iconPlays).toEqual([]);
    await user.click(entry);
    expect(iconPlays).toEqual(['newChat']);
  });

  describe('bell', () => {
    afterEach(() => { vi.useRealTimers(); });

    async function loaded() {
      const r = renderKb();
      const bell = await screen.findByRole('button', { name: /^Notifications/ });
      await waitFor(() => expect(bell).toHaveAccessibleName('Notifications, 1 unread'));
      return { ...r, bell };
    }
    const unread = (r: Awaited<ReturnType<typeof loaded>>, n: number) => act(() => { r.services.notifications.setState({ unread: n }); });

    it('does not move for the unread count the first read brings, nor on hover', async () => {
      const { bell } = await loaded();
      await userEvent.setup().hover(bell);
      expect(iconPlays).toEqual([]);
    });

    it('moves when unread goes up, never when it goes down, at most once in 5 s', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T12:00:00Z') });
      const r = await loaded();
      unread(r, 2);
      expect(iconPlays).toEqual(['bell']);
      unread(r, 3); // 1 s later is too soon
      vi.setSystemTime(Date.now() + 1000);
      unread(r, 4);
      expect(iconPlays).toEqual(['bell']);
      unread(r, 0); // read: a fall is not news
      expect(iconPlays).toEqual(['bell']);
      vi.setSystemTime(Date.now() + BELL_MIN_GAP_MS + 1);
      unread(r, 1);
      expect(iconPlays).toEqual(['bell', 'bell']);
      unread(r, 1); // same count again: nothing
      expect(iconPlays).toEqual(['bell', 'bell']);
    });
  });

  describe('record', () => {
    function engine(): CaptureEngine {
      return {
        start: vi.fn(async () => undefined), pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined),
        stop: vi.fn(async () => true), elapsedMs: () => 0, pending: () => ({ pending: 0, failed: 0 }),
      };
    }

    it('the mic plays once when a recording starts, not on hover', async () => {
      const user = userEvent.setup();
      renderKb({ world: docWorld(), capture: () => engine() });
      const record = await within(screen.getByTestId('titlebar')).findByRole('button', { name: 'Record' });
      await waitFor(() => expect(record).not.toHaveAttribute('aria-disabled'));
      await user.hover(record);
      expect(iconPlays).toEqual([]);
      await user.click(record);
      await waitFor(() => expect(iconPlays).toEqual(['mic']));
    });

    it('the starting spinner takes the mic’s place only after it has moved', async () => {
      const user = userEvent.setup();
      const stuck = engine();
      stuck.start = vi.fn(() => new Promise<void>(() => undefined)); // the capture never comes up: stays «starting»
      renderKb({ world: docWorld(), capture: () => stuck });
      const record = await within(screen.getByTestId('titlebar')).findByRole('button', { name: 'Record' });
      await waitFor(() => expect(record).not.toHaveAttribute('aria-disabled'));
      await user.click(record);
      await waitFor(() => expect(record).toHaveAttribute('aria-disabled', 'true')); // phase «starting»
      expect(record.querySelector('[data-icon="mic"]')).toBeInTheDocument();
      expect(record.querySelector('.kb-spinner')).not.toBeInTheDocument();
      await waitFor(() => expect(record.querySelector('.kb-spinner')).toBeInTheDocument(), { timeout: ICON_PLAY_MS + 1500 });
      expect(record.querySelector('[data-icon="mic"]')).not.toBeInTheDocument();
      expect(iconPlays).toEqual(['mic']);
    });
  });
});

