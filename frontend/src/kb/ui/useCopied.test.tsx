import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { COPIED_MS, useCopied } from './useCopied';

function Probe() {
  const [copied, mark] = useCopied();
  return (
    <>
      <span data-testid="state">{copied ? 'copied' : 'idle'}</span>
      <button type="button" onClick={() => mark(true)}>ok</button>
      <button type="button" onClick={() => mark(false)}>fail</button>
    </>
  );
}

afterEach(() => { vi.useRealTimers(); });

describe('useCopied — «Copied» is a moment, not a state', () => {
  it('turns back after COPIED_MS; copying again restarts the time; a failed copy clears it at once', () => {
    vi.useFakeTimers();
    render(<Probe />);
    const state = () => screen.getByTestId('state').textContent;
    act(() => screen.getByText('ok').click());
    expect(state()).toBe('copied');
    act(() => { vi.advanceTimersByTime(COPIED_MS - 200); });
    act(() => screen.getByText('ok').click());
    act(() => { vi.advanceTimersByTime(COPIED_MS - 200); });
    expect(state()).toBe('copied');
    act(() => { vi.advanceTimersByTime(250); });
    expect(state()).toBe('idle');
    act(() => screen.getByText('ok').click());
    act(() => screen.getByText('fail').click());
    expect(state()).toBe('idle');
  });

  it('the answer’s Copy says Copied with a ✓, then is Copy again', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
    const answer = await within(screen.getByRole('region', { name: 'Chat' })).findByRole('article', { name: 'Answer' });
    await user.click(within(answer).getByRole('button', { name: 'Copy' }));
    expect(await within(answer).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(await within(answer).findByRole('button', { name: 'Copy' }, { timeout: COPIED_MS + 1500 })).toBeInTheDocument();
    expect(within(answer).queryByRole('button', { name: 'Copied' })).toBeNull();
  });
});
