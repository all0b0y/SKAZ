import { describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { LEAVE_MS, LEAVE_REDUCED_MS } from './ChatView';

// prefers-reduced-motion: reduce — set before Motion first reads it (this file only).
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

const centre = () => screen.getByRole('region', { name: 'Chat' });
const stage = () => centre().querySelector('.kb-chat__stage')!;
const field = () => centre().querySelector('canvas.kb-fx-field');

describe('Empty chat field with reduced motion (FX global rules)', () => {
  it('one still frame, no interaction; the first message is a short fade', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.hold = true;
    renderKb({ world });
    await within(screen.getByRole('region', { name: 'Chats' })).findByRole('region', { name: 'Pinned' });
    expect(field()).toHaveAttribute('aria-hidden', 'true');
    expect(stage()).toHaveAttribute('data-still', 'true');
    expect(stage()).not.toHaveAttribute('data-interactive'); // no crosshair, clicks do nothing
    // The leave timer is held: its length is read from the call, not from the wall clock (quality Q8).
    const real = window.setTimeout.bind(window);
    const delays: number[] = [];
    const held: Array<() => void> = [];
    vi.spyOn(window, 'setTimeout').mockImplementation(((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
      if ((delay === LEAVE_REDUCED_MS || delay === LEAVE_MS) && typeof fn === 'function') {
        delays.push(delay);
        held.push(() => (fn as () => void)());
        return 0;
      }
      return real(fn, delay, ...args);
    }) as typeof window.setTimeout);
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('What is entropy?{Enter}');
    await within(centre()).findByRole('article', { name: 'Your question' });
    expect(stage()).toHaveAttribute('data-fx', 'leaving');
    const messages = centre().querySelector('.kb-chat__messages')!;
    expect(messages).toHaveClass('kb-chat__messages--fade');
    expect(messages).not.toHaveClass('kb-chat__messages--enter');
    // The fade is the short one (≤ 200 ms), not the 700 ms burn-out.
    expect(delays).toEqual([LEAVE_REDUCED_MS]);
    act(() => { held.splice(0).forEach((f) => f()); });
    vi.restoreAllMocks();
    expect(field()).toBeNull();
    // The waiting mark is still there, as a still frame beside the words.
    const wait = within(centre()).getByText('Writing an answer…');
    expect(wait.querySelector('canvas.kb-msg__think')).toHaveAttribute('aria-hidden', 'true');
  });
});
