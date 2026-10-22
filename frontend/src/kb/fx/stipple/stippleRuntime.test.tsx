import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { ChipStipple } from './ChipStipple';
import { StippleStrip } from './StippleStrip';

/** A recording 2D context: enough surface for FxCanvas and the stipple painters. */
function fakeCtx() {
  const ctx = {
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillRect: vi.fn(),
    fillStyle: '',
  };
  return ctx;
}

/** Stubs rAF with a manual queue and a fake clock; `run(ms)` plays frames ~33 ms apart. */
function frames() {
  let now = 0;
  let id = 0;
  const queue = new Map<number, (t: number) => void>();
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { queue.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (i: number) => { queue.delete(i); });
  const run = (ms: number) => {
    const end = now + ms;
    while (now < end && queue.size) {
      now += 33;
      const batch = [...queue.values()];
      queue.clear();
      act(() => batch.forEach((f) => f(now)));
    }
  };
  return { queue, run };
}

function sized(w: number, h: number) {
  const ctx = fakeCtx();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: w, height: h, left: 0, top: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}),
  });
  return ctx;
}

describe('stipple runtime: loops stop when nothing changes, light backing stores', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('chip: once the dots have settled the loop stops, though the chip stays on (a pinned popover)', () => {
    const ctx = sized(96, 76);
    const { queue, run } = frames();
    const { rerender } = render(<ChipStipple on />);
    expect(queue.size).toBe(1); // hover: the dots move out
    run(200);
    expect(ctx.arc).toHaveBeenCalled(); // dots drawn
    run(1500);
    expect(queue.size).toBe(0); // settled: no loop while the popover stays pinned
    const drawn = ctx.arc.mock.calls.length;
    run(1000);
    expect(ctx.arc.mock.calls.length).toBe(drawn); // nothing redrawn
    // Leaving moves the dots back: the loop runs again until they are still.
    rerender(<ChipStipple on={false} />);
    expect(queue.size).toBe(1);
    run(1500);
    expect(queue.size).toBe(0);
  });

  it('progress strip: the backing store is at dpr 1 (a 6-px dot band at full row width)', () => {
    sized(200, 6);
    frames();
    const { container } = render(<StippleStrip />);
    const cv = container.querySelector('canvas')!;
    expect(cv.width).toBe(200);
    expect(cv.height).toBe(6);
  });
});
