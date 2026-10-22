import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { FX_FRAME_MS, FX_REST_MS, useFxLoop } from './loop';
import { FxCanvas } from './FxCanvas';
import type { FxColors } from './colors';
import { DitherStage } from './dither/DitherStage';

/*
 * The runtime contract of every effect (FX-EFFECTS-SPEC «Global rules», review Q4/Q5/Q16): one
 * throttled rAF loop, paused while the window is hidden, stopped when inactive or off-screen, a single
 * still frame under reduced motion, a clock that pauses instead of restarting, colours that follow
 * the theme. rAF and document.hidden are driven by hand: no wall clock.
 */

let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextId = 1;
let hidden = false;
/** Runs the frames queued so far at time `now` (ms). */
const frame = (now: number) => {
  const q = queue;
  queue = [];
  act(() => { q.forEach((f) => f.cb(now)); });
};

beforeEach(() => {
  queue = [];
  hidden = false;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextId++; queue.push({ id, cb }); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue = queue.filter((f) => f.id !== id); });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as { hidden?: boolean }).hidden;
  document.documentElement.removeAttribute('data-theme');
});

describe('useFxLoop', () => {
  it('draws at most every FX_FRAME_MS (~30 fps): closer frames are skipped', () => {
    const draw = vi.fn();
    renderHook(() => useFxLoop(draw, { active: true, reduced: false }));
    frame(1000);
    expect(draw).toHaveBeenLastCalledWith(0, 0); // the first frame: dt 0
    frame(1016);
    frame(1030);
    expect(draw).toHaveBeenCalledTimes(1);
    frame(1000 + FX_FRAME_MS);
    expect(draw).toHaveBeenCalledTimes(2);
    const [dt, t] = draw.mock.calls[1]!;
    expect(dt).toBeCloseTo(FX_FRAME_MS / 1000, 6);
    expect(t).toBeCloseTo(FX_FRAME_MS / 1000, 6);
  });

  it('a hidden window gets no frames at all; visibilitychange resumes it without a jump', () => {
    const draw = vi.fn();
    renderHook(() => useFxLoop(draw, { active: true, reduced: false }));
    frame(0);
    frame(40);
    const t = draw.mock.calls.at(-1)![1] as number;
    hidden = true;
    frame(80);
    expect(queue).toHaveLength(0); // no rAF is scheduled while hidden
    const calls = draw.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange')); // still hidden: nothing restarts
    expect(queue).toHaveLength(0);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(queue).toHaveLength(1);
    frame(60_000);
    expect(draw).toHaveBeenCalledTimes(calls + 1);
    expect(draw).toHaveBeenLastCalledWith(0, t); // the same moment as before the pause
  });

  it('stops when inactive and on unmount; shown again it goes on from the same moment (Q16: no clock reset)', () => {
    const draw = vi.fn();
    const { rerender, unmount } = renderHook(({ active }) => useFxLoop(draw, { active, reduced: false }), { initialProps: { active: true } });
    frame(0);
    frame(100);
    const t = draw.mock.calls.at(-1)![1] as number;
    expect(t).toBeGreaterThan(0);
    rerender({ active: false });
    expect(queue).toHaveLength(0);
    frame(200);
    const calls = draw.mock.calls.length;
    rerender({ active: true });
    frame(90_000);
    expect(draw).toHaveBeenCalledTimes(calls + 1);
    expect(draw).toHaveBeenLastCalledWith(0, t);
    frame(90_000 + FX_FRAME_MS);
    expect(draw.mock.calls.at(-1)![1]).toBeGreaterThan(t);
    unmount();
    expect(queue).toHaveLength(0);
  });

  it('reduced motion: one still frame at fixedT, no loop', () => {
    const draw = vi.fn();
    const { rerender } = renderHook(() => useFxLoop(draw, { active: true, reduced: true, fixedT: 2.4 }));
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledWith(0, 2.4);
    expect(queue).toHaveLength(0);
    rerender();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('frameMs as a function is asked every tick: an effect at rest drops to ≤ 4 fps, then speeds up at once', () => {
    const draw = vi.fn();
    let busy = false;
    renderHook(() => useFxLoop(draw, { active: true, reduced: false, frameMs: () => (busy ? FX_FRAME_MS : FX_REST_MS) }));
    expect(FX_REST_MS).toBeGreaterThanOrEqual(250);
    frame(0);
    for (let now = 31; now < FX_REST_MS; now += 31) frame(now);
    expect(draw).toHaveBeenCalledTimes(1);
    frame(FX_REST_MS);
    expect(draw).toHaveBeenCalledTimes(2);
    // The rest frame advances the clock by the real gap (the drift keeps its speed).
    expect(draw.mock.calls[1]![1]).toBeCloseTo(FX_REST_MS / 1000, 6);
    busy = true;
    frame(FX_REST_MS + FX_FRAME_MS);
    expect(draw).toHaveBeenCalledTimes(3);
  });
});

/** A 2D context with just what FxCanvas calls. */
const fakeCtx = () => ({ setTransform: vi.fn(), clearRect: vi.fn(), canvas: null as unknown });

function mountCanvas(props: Partial<Parameters<typeof FxCanvas>[0]> = {}) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const c = fakeCtx();
    c.canvas = this;
    return c as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 84, height: 16 } as DOMRect);
  const onFrame = vi.fn();
  const view = render(<FxCanvas active reduced={false} onFrame={onFrame} {...props} />);
  return { ...view, onFrame, canvas: view.container.querySelector('canvas')! };
}

describe('FxCanvas', () => {
  it('stops its loop while its canvas is off-screen or in a hidden section (IntersectionObserver), restarts when seen', () => {
    let notify: ((entries: Array<Partial<IntersectionObserverEntry>>) => void) | null = null;
    const observed: Element[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (entries: Array<Partial<IntersectionObserverEntry>>) => void) { notify = cb; }
      observe(el: Element) { observed.push(el); }
      unobserve() { /* nothing */ }
      disconnect() { notify = null; }
    });
    const { onFrame, canvas, unmount } = mountCanvas();
    expect(observed).toEqual([canvas]);
    expect(queue.length).toBeGreaterThan(0);
    act(() => notify!([{ isIntersecting: false, target: canvas }]));
    expect(queue).toHaveLength(0); // no loop off-screen
    const calls = onFrame.mock.calls.length;
    frame(500);
    expect(onFrame).toHaveBeenCalledTimes(calls);
    act(() => notify!([{ isIntersecting: true, target: canvas }]));
    expect(queue.length).toBeGreaterThan(0);
    frame(600);
    expect(onFrame).toHaveBeenCalledTimes(calls + 1);
    unmount();
    expect(notify).toBeNull(); // disconnected
    expect(queue).toHaveLength(0);
  });

  it('inactive: no loop, but a resize or redrawKey still paints the current moment', () => {
    const { onFrame, rerender } = mountCanvas({ active: false });
    expect(queue).toHaveLength(0);
    expect(onFrame).toHaveBeenCalledTimes(1); // the first measure
    rerender(<FxCanvas active={false} reduced={false} onFrame={onFrame} redrawKey={1} />);
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(queue).toHaveLength(0);
  });

  it('re-reads the colours when html[data-theme] changes', async () => {
    const { onFrame, canvas } = mountCanvas({ active: false });
    const colors = () => onFrame.mock.calls.at(-1)![5] as FxColors;
    expect(colors().ink).toEqual([44, 46, 49]); // the light fallback
    canvas.style.setProperty('--kb-text', '#f9f8f3');
    canvas.style.setProperty('--kb-fx-accent', '#bfa4f4');
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      await Promise.resolve();
    });
    expect(colors()).toMatchObject({ ink: [249, 248, 243], accent: [191, 164, 244] });
  });
});

describe('DitherStage frame rate (review Q3)', () => {
  /** Enough 2D surface for FxCanvas and the scene; every draw of the field is one putImageData. */
  const sceneCtx = () => ({
    setTransform: vi.fn(), clearRect: vi.fn(), canvas: null as unknown,
    fillStyle: '', font: '', textAlign: 'center', textBaseline: 'middle', imageSmoothingEnabled: true,
    measureText: () => ({ width: 300 }),
    fillText: () => undefined,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: vi.fn(),
    drawImage: vi.fn(),
  });

  it('at rest ≤ 4 fps; ~30 fps while links live and while it burns out', () => {
    const ctx = sceneCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      ctx.canvas = this;
      return ctx as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement['getContext']);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 600, height: 400 } as DOMRect);
    const stage = (leaving: boolean) => (
      <DitherStage show leaving={leaving} active reduced={false} className="stage"><p>thread</p></DitherStage>
    );
    const { container, rerender } = render(stage(false));
    const draws = () => ctx.putImageData.mock.calls.length;
    /** Draws over one second of 31-ms ticks starting at `from` (ms). */
    const second = (from: number) => {
      const n = draws();
      for (let now = from; now < from + 1000; now += FX_FRAME_MS) frame(now);
      return draws() - n;
    };
    second(0); // the first measure and frame
    expect(second(1000)).toBeLessThanOrEqual(4);
    fireEvent.pointerDown(container.querySelector('.stage')!, { clientX: 300, clientY: 200 });
    expect(second(2000)).toBeGreaterThanOrEqual(25); // links grow and hold: full rate
    second(3000);
    second(4000);
    second(5000); // the last links have faded (≈ 3.2 s with the BFS delays)
    expect(second(6000)).toBeLessThanOrEqual(4);
    rerender(stage(true));
    expect(second(7000)).toBeGreaterThanOrEqual(25); // the burn-out
  });
});
