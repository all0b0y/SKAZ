import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { ChatBackdrop } from './ChatBackdrop';
import { WORKING_FRAME_MS } from './backdrop';

/*
 * The backdrop's runtime (CHAT-BACKDROP-SPEC «Motion»): a still frame and no loop at rest, ~15 fps
 * while the agent works, back to no loop once it has settled, nothing but one still frame under
 * reduced motion, no loop while the view is hidden. rAF is driven by hand (the loop.test pattern).
 */

let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextId = 1;
const frame = (now: number) => {
  const q = queue;
  queue = [];
  act(() => { q.forEach((f) => f.cb(now)); });
};

/** Enough 2D surface for FxCanvas and the scene; every drawn frame is one putImageData. */
const sceneCtx = () => ({
  setTransform: vi.fn(), clearRect: vi.fn(), canvas: null as unknown, imageSmoothingEnabled: true,
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: vi.fn(),
  drawImage: vi.fn(),
});
let ctx = sceneCtx();

beforeEach(() => {
  queue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextId++; queue.push({ id, cb }); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue = queue.filter((f) => f.id !== id); });
  ctx = sceneCtx();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    ctx.canvas = this;
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 900, height: 600 } as DOMRect);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const draws = () => ctx.putImageData.mock.calls.length;
/** Draws over `ms` of 16-ms ticks starting at `from`. */
const run = (from: number, ms: number) => {
  const n = draws();
  for (let now = from; now < from + ms; now += 16) frame(now);
  return draws() - n;
};

describe('ChatBackdrop runtime', () => {
  it('at rest: one still frame, no loop; decorative and inert', () => {
    const { container } = render(<ChatBackdrop working={false} active reduced={false} />);
    const wrap = container.querySelector('.kb-chat__backdrop')!;
    expect(wrap).toHaveAttribute('aria-hidden', 'true');
    expect(wrap).not.toHaveAttribute('data-working');
    expect(wrap.querySelector('canvas.kb-fx-backdrop')).toHaveAttribute('aria-hidden', 'true');
    expect(draws()).toBe(1);
    expect(queue).toHaveLength(0);
  });

  it('while the agent works it flows at ~15 fps; after, it settles and the loop stops on a still frame', () => {
    const { container, rerender } = render(<ChatBackdrop working={false} active reduced={false} />);
    expect(queue).toHaveLength(0);
    rerender(<ChatBackdrop working active reduced={false} />);
    expect(container.querySelector('.kb-chat__backdrop')).toHaveAttribute('data-working', 'true');
    expect(queue.length).toBeGreaterThan(0);
    run(0, 1000);
    const perSecond = run(1000, 1000);
    expect(perSecond).toBeGreaterThanOrEqual(Math.floor(1000 / WORKING_FRAME_MS) - 2);
    expect(perSecond).toBeLessThanOrEqual(16);
    rerender(<ChatBackdrop working={false} active reduced={false} />);
    expect(container.querySelector('.kb-chat__backdrop')).not.toHaveAttribute('data-working');
    // The energy eases down (~6 s) and stays still for 2 s: then no more frames.
    let t = 2000;
    while (queue.length > 0 && t < 20000) { run(t, 500); t += 500; }
    expect(queue).toHaveLength(0);
    expect(t).toBeGreaterThan(2000 + 5000);
    const still = draws();
    run(t, 2000);
    expect(draws()).toBe(still);
    // Work again: the loop comes back.
    rerender(<ChatBackdrop working active reduced={false} />);
    expect(queue.length).toBeGreaterThan(0);
  });

  it('reduced motion: one still frame, no loop, no change while working', () => {
    const { container, rerender } = render(<ChatBackdrop working active reduced />);
    const wrap = container.querySelector('.kb-chat__backdrop')!;
    expect(wrap).toHaveAttribute('data-still', 'true');
    expect(wrap).not.toHaveAttribute('data-working');
    expect(queue).toHaveLength(0);
    const n = draws();
    expect(n).toBeGreaterThanOrEqual(1);
    const firstFrame = ctx.putImageData.mock.calls[0]![0] as ImageData;
    const pixels = Array.from(firstFrame.data);
    rerender(<ChatBackdrop working={false} active reduced />);
    rerender(<ChatBackdrop working active reduced />);
    expect(queue).toHaveLength(0);
    expect(Array.from((ctx.putImageData.mock.calls.at(-1)![0] as ImageData).data)).toEqual(pixels);
  });

  it('a hidden chat view runs no loop, even while the agent works', () => {
    render(<ChatBackdrop working active={false} reduced={false} />);
    expect(queue).toHaveLength(0);
  });
});
