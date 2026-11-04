import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AT_ONCE, STALL_MS, useFrameQueue } from './frameQueue';
import { markReady, SETTLE_MS } from './live';

const list = (prefix: string, n = 8) => Array.from({ length: n }, (_, i) => `#${prefix}-${i}`);
const loaded = (may: (hash: string) => boolean, order: readonly string[]) => order.filter(may).length;

/** What a frame posts to the canvas when it is done (live.ts markReady). */
function ready(hash: string | undefined, origin = window.location.origin) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { origin, data: hash === undefined ? { kbBoard: 'ready' } : { kbBoard: 'ready', hash } })); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('board canvas · frame queue (B3)', () => {
  it('loads AT_ONCE frames, then one more for every frame that says it is ready', () => {
    const a = list('a');
    const { result } = renderHook(({ order }) => useFrameQueue(order), { initialProps: { order: a } });
    expect(loaded(result.current, a)).toBe(AT_ONCE);
    expect(result.current(a[0]!)).toBe(true);
    expect(result.current(a[AT_ONCE]!)).toBe(false);
    ready(a[0]);
    expect(loaded(result.current, a)).toBe(AT_ONCE + 1);
    expect(result.current(a[AT_ONCE]!)).toBe(true);
  });

  it('a frame counts once, and only while it is loaded on the canvas now (stale or foreign ready is ignored)', () => {
    const a = list('a');
    const { result } = renderHook(({ order }) => useFrameQueue(order), { initialProps: { order: a } });
    ready(a[1]);
    ready(a[1]); // the same frame again (StrictMode, a reload) — still one
    expect(loaded(result.current, a)).toBe(AT_ONCE + 1);
    ready('#gone-0'); // a frame of an earlier canvas (another layer, base, accent…)
    ready(a[7]); // a frame that has no src yet can't be ready
    ready(undefined); // no address at all
    ready(a[2], 'http://elsewhere.test'); // another origin
    expect(loaded(result.current, a)).toBe(AT_ONCE + 1);
  });

  it('a new order starts over in the same render, not one render late', () => {
    const a = list('a');
    const b = list('b');
    // Every render's answer for the order it rendered with (an iframe gets its src in that render).
    const seen: Array<[string, number]> = [];
    const { result, rerender } = renderHook(({ order }) => {
      const may = useFrameQueue(order);
      seen.push([order[0]!, loaded(may, order)]);
      return may;
    }, { initialProps: { order: a } });
    ready(a[0]); ready(a[1]); ready(a[2]);
    expect(loaded(result.current, a)).toBe(AT_ONCE + 3);
    seen.length = 0;
    rerender({ order: b });
    // No render of the new order may hand out more than AT_ONCE addresses.
    expect(seen.length).toBeGreaterThan(0);
    for (const [first, n] of seen) expect([first, n]).toEqual([b[0], AT_ONCE]);
    // And the readies of the earlier canvas don't open frames of this one.
    ready(a[3]);
    expect(loaded(result.current, b)).toBe(AT_ONCE);
  });

  it('frames that stay loaded across a new order keep counting as ready (no stall for them)', () => {
    const a = list('a');
    const { result, rerender } = renderHook(({ order }) => useFrameQueue(order), { initialProps: { order: a } });
    ready(a[0]); ready(a[1]);
    expect(loaded(result.current, a)).toBe(AT_ONCE + 2);
    // A text size added at the end: the first frames keep their address and stay up.
    const more = [...a, '#extra-0', '#extra-1'];
    rerender({ order: more });
    expect(loaded(result.current, more)).toBe(AT_ONCE + 2);
  });

  it('a stalled frame lets the next one start after STALL_MS; the timer stops once every frame may load', () => {
    const a = list('a', 5);
    const { result } = renderHook(({ order }) => useFrameQueue(order), { initialProps: { order: a } });
    act(() => { vi.advanceTimersByTime(STALL_MS - 1); });
    expect(loaded(result.current, a)).toBe(AT_ONCE);
    act(() => { vi.advanceTimersByTime(1); });
    expect(loaded(result.current, a)).toBe(AT_ONCE + 1);
    ready(a[0]); // progress re-arms the timer from now
    expect(loaded(result.current, a)).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(STALL_MS * 10); });
    expect(loaded(result.current, a)).toBe(5);
  });

  it('no timer runs on a canvas without queued frames (layer 1)', () => {
    renderHook(() => useFrameQueue([]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a frame says which address is ready (live.ts markReady)', () => {
    const postMessage = vi.fn();
    const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    window.history.replaceState(null, '', '#design-board/pattern?id=toast&theme=dark');
    try {
      markReady();
      act(() => { vi.advanceTimersByTime(SETTLE_MS); });
      expect(postMessage).toHaveBeenCalledWith({ kbBoard: 'ready', hash: '#design-board/pattern?id=toast&theme=dark' }, window.location.origin);
    } finally {
      parent.mockRestore();
      window.history.replaceState(null, '', '#');
      delete document.documentElement.dataset.boardReady;
    }
  });
});
