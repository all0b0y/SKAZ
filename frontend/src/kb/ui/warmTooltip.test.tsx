import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Tooltip, TOOLTIP_WAIT_MS, TOOLTIP_WARM_MS, resetTooltipWarmth } from './Tooltip';

/* WarmTooltip (stage 6, B5): the first tooltip waits; neighbours open at once while the row is warm. */

beforeEach(() => { vi.useFakeTimers(); resetTooltipWarmth(); });
afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
});

function Row() {
  return (
    <div>
      <Tooltip text="Search in chat"><button type="button" aria-label="Search">S</button></Tooltip>
      <Tooltip text="Pin"><button type="button" aria-label="Pin it">P</button></Tooltip>
      <Tooltip text="More"><button type="button" aria-label="More actions">M</button></Tooltip>
    </div>
  );
}
const btn = (name: string) => screen.getByRole('button', { name });
const tip = () => screen.queryByRole('tooltip');
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('WarmTooltip (B5)', () => {
  it('uses the demo timings: 500 ms to the first tooltip, 800 ms warm after leaving', () => {
    expect(TOOLTIP_WAIT_MS).toBe(500);
    expect(TOOLTIP_WARM_MS).toBe(800);
  });

  it('the first tooltip waits ~500 ms and enters with a short rise; the next one opens at once, no entrance', () => {
    render(<Row />);
    fireEvent.mouseEnter(btn('Search'));
    wait(TOOLTIP_WAIT_MS - 1);
    expect(tip()).toBeNull();
    wait(1);
    expect(tip()).toHaveTextContent('Search in chat');
    expect(tip()).toHaveAttribute('data-enter', 'rise');
    fireEvent.mouseLeave(btn('Search'));
    expect(tip()).toBeNull();
    fireEvent.mouseEnter(btn('Pin it'));
    expect(tip()).toHaveTextContent('Pin');
    expect(tip()).not.toHaveAttribute('data-enter');
  });

  it('stays warm for ~800 ms after the pointer leaves the row, then the wait comes back', () => {
    render(<Row />);
    fireEvent.mouseEnter(btn('Search'));
    wait(TOOLTIP_WAIT_MS);
    fireEvent.mouseLeave(btn('Search'));
    wait(TOOLTIP_WARM_MS - 1);
    fireEvent.mouseEnter(btn('More actions'));
    expect(tip()).toHaveTextContent('More'); // still warm
    fireEvent.mouseLeave(btn('More actions'));
    wait(TOOLTIP_WARM_MS);
    fireEvent.mouseEnter(btn('Pin it'));
    expect(tip()).toBeNull(); // cold again
    wait(TOOLTIP_WAIT_MS);
    expect(tip()).toHaveTextContent('Pin');
  });

  it('leaving before the wait ends opens nothing and leaves the row cold', () => {
    render(<Row />);
    fireEvent.mouseEnter(btn('Search'));
    wait(300);
    fireEvent.mouseLeave(btn('Search'));
    wait(TOOLTIP_WAIT_MS);
    expect(tip()).toBeNull();
    fireEvent.mouseEnter(btn('Pin it'));
    expect(tip()).toBeNull();
  });

  it('one shared warm state across separately mounted tooltips', () => {
    render(<><Tooltip text="Left"><button type="button">L</button></Tooltip></>);
    render(<><Tooltip text="Right"><button type="button">R</button></Tooltip></>);
    fireEvent.mouseEnter(btn('L'));
    wait(TOOLTIP_WAIT_MS);
    fireEvent.mouseLeave(btn('L'));
    fireEvent.mouseEnter(btn('R'));
    expect(tip()).toHaveTextContent('Right');
  });

  it('Escape and blur still close it', () => {
    render(<Row />);
    fireEvent.mouseEnter(btn('Search'));
    wait(TOOLTIP_WAIT_MS);
    expect(tip()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(tip()).toBeNull();
    fireEvent.mouseLeave(btn('Search'));
    fireEvent.mouseEnter(btn('Pin it'));
    expect(tip()).not.toBeNull();
    fireEvent.blur(btn('Pin it'));
    expect(tip()).toBeNull();
  });

  it('calm: the first tooltip fades (no rise); off: it appears with no entrance — the timing rule holds at every level', () => {
    document.documentElement.dataset.motion = 'calm';
    const { unmount } = render(<Row />);
    fireEvent.mouseEnter(btn('Search'));
    wait(TOOLTIP_WAIT_MS - 1);
    expect(tip()).toBeNull();
    wait(1);
    expect(tip()).toHaveAttribute('data-enter', 'fade');
    unmount();
    resetTooltipWarmth();
    document.documentElement.dataset.motion = 'off';
    render(<Row />);
    fireEvent.mouseEnter(btn('Search'));
    wait(TOOLTIP_WAIT_MS - 1);
    expect(tip()).toBeNull();
    wait(1);
    expect(tip()).not.toHaveAttribute('data-enter');
  });

  describe('warmth counts open tooltips (FIX2 C-L2)', () => {
    it('stays warm while ANY tooltip is open: another one closing does not cool the row', () => {
      render(<Row />);
      fireEvent.mouseEnter(btn('Search')); // the first one: open after the wait, and it stays open
      wait(TOOLTIP_WAIT_MS);
      fireEvent.mouseEnter(btn('Pin it')); // a second one opens (warm) and closes
      fireEvent.mouseLeave(btn('Pin it'));
      wait(TOOLTIP_WARM_MS * 3); // «Search in chat» is still open all this time
      expect(screen.getByRole('tooltip', { name: 'Search in chat' })).toBeInTheDocument();
      fireEvent.mouseEnter(btn('More actions'));
      expect(screen.getByRole('tooltip', { name: 'More' })).not.toHaveAttribute('data-enter'); // at once: warm
      fireEvent.mouseLeave(btn('More actions'));
      fireEvent.mouseLeave(btn('Search'));
      wait(TOOLTIP_WARM_MS - 1);
      fireEvent.mouseEnter(btn('Pin it'));
      expect(tip()).toHaveTextContent('Pin'); // the last one closed < 800 ms ago
      fireEvent.mouseLeave(btn('Pin it'));
      wait(TOOLTIP_WARM_MS);
      fireEvent.mouseEnter(btn('More actions'));
      expect(tip()).toBeNull(); // none open for 800 ms: cold
    });

    it('one tooltip shown twice (pointer, then again) counts once: it cools 800 ms after it closes', () => {
      render(<Row />);
      fireEvent.mouseEnter(btn('Search'));
      wait(TOOLTIP_WAIT_MS);
      fireEvent.mouseEnter(btn('Search'));
      fireEvent.mouseLeave(btn('Search'));
      wait(TOOLTIP_WARM_MS);
      fireEvent.mouseEnter(btn('Pin it'));
      expect(tip()).toBeNull();
    });

    it('an open tooltip that unmounts counts as closed', () => {
      const { unmount } = render(<Tooltip text="Gone"><button type="button">G</button></Tooltip>);
      render(<Tooltip text="Stays"><button type="button">K</button></Tooltip>);
      fireEvent.mouseEnter(btn('G'));
      wait(TOOLTIP_WAIT_MS);
      unmount();
      wait(TOOLTIP_WARM_MS);
      fireEvent.mouseEnter(btn('K'));
      expect(tip()).toBeNull();
    });
  });

  it('a disabled-reason tooltip on a wrapper still opens after the wait', () => {
    render(
      <Tooltip text="Connect the library first">
        <span><button type="button" disabled>Add</button></span>
      </Tooltip>,
    );
    fireEvent.mouseEnter(btn('Add').parentElement!);
    wait(TOOLTIP_WAIT_MS);
    expect(tip()).toHaveTextContent('Connect the library first');
  });
});
