import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PIXEL_CELL, PIXEL_FRINGE, pixelField, pixelThreshold, drawPixelCover, pixelFrame } from './pixel';
import { PIXEL_HALF_MS, CALM_OUT_MS, CALM_IN_MS, usePixelSwap } from './usePixelSwap';
import { vi, afterEach } from 'vitest';

// Stage 6 B6 PixelTransition (decision 30): dither cells (Bayer order + value noise, a front moving down).

afterEach(() => { vi.useRealTimers(); });

describe('pixelField: the order cells cover and uncover in', () => {
  it('normalised to [0, 1], deterministic, mostly top-to-bottom', () => {
    const f = pixelField(40, 30);
    expect(f.values).toHaveLength(40 * 30);
    expect(Math.max(...f.values)).toBeCloseTo(1);
    expect(Math.min(...f.values)).toBeGreaterThanOrEqual(0);
    expect(pixelField(40, 30).values).toEqual(f.values);
    const row = (y: number) => f.values.slice(y * 40, (y + 1) * 40).reduce((a, b) => a + b, 0) / 40;
    expect(row(0)).toBeLessThan(row(15));
    expect(row(15)).toBeLessThan(row(29));
  });

  it('the threshold runs from below every cell to above every cell over a half', () => {
    expect(pixelThreshold(0)).toBeLessThan(0);
    expect(pixelThreshold(1)).toBeGreaterThan(1);
  });

  it('cover paints the cells under the front; reveal paints the ones not yet passed; the fringe is the accent', () => {
    const f = pixelField(10, 10);
    const rects: Array<[string, number, number]> = [];
    let style = '';
    const ctx = {
      set fillStyle(v: string) { style = v; }, get fillStyle() { return style; },
      clearRect() {}, fillRect(x: number, y: number) { rects.push([style, x, y]); },
    } as unknown as CanvasRenderingContext2D;
    const colors = { pane: [255, 255, 255] as const, accent: [255, 0, 0] as const };
    drawPixelCover(ctx, f, 40, 40, 1.1, true, colors);
    expect(rects.filter(([s]) => s.startsWith('rgba(255,255,255')).length).toBe(100); // fully covered
    rects.length = 0;
    drawPixelCover(ctx, f, 40, 40, -0.1, false, colors);
    expect(rects.filter(([s]) => s.startsWith('rgba(255,255,255')).length).toBe(100); // reveal not started
    rects.length = 0;
    drawPixelCover(ctx, f, 40, 40, 0.5, true, colors);
    const pane = rects.filter(([s]) => s.startsWith('rgba(255,255,255')).length;
    expect(pane).toBeGreaterThan(0);
    expect(pane).toBeLessThan(100);
    expect(rects.some(([s]) => s.startsWith('rgba(255,0,0'))).toBe(true);
    expect(PIXEL_CELL).toBe(4);
    expect(PIXEL_FRINGE).toBe(0.06);
  });
});

describe('usePixelSwap: shows the old value under the cover, the new one after', () => {
  const plays = (_a: string, _b: string) => true;

  it('full: cover → swap at the half → reveal → idle, then counts the swap', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => usePixelSwap(v, plays, 'full'), { initialProps: { v: 'old' } });
    expect(result.current).toMatchObject({ shown: 'old', phase: 'idle', played: 0 });
    rerender({ v: 'new' });
    expect(result.current).toMatchObject({ shown: 'old', phase: 'cover' });
    act(() => { vi.advanceTimersByTime(PIXEL_HALF_MS); });
    expect(result.current).toMatchObject({ shown: 'new', phase: 'reveal' });
    act(() => { vi.advanceTimersByTime(PIXEL_HALF_MS); });
    expect(result.current).toMatchObject({ shown: 'new', phase: 'idle', played: 1 });
  });

  it('calm: a plain crossfade (out, swap, in)', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => usePixelSwap(v, plays, 'calm'), { initialProps: { v: 'old' } });
    rerender({ v: 'new' });
    expect(result.current).toMatchObject({ shown: 'old', phase: 'fade-out' });
    act(() => { vi.advanceTimersByTime(CALM_OUT_MS); });
    expect(result.current).toMatchObject({ shown: 'new', phase: 'fade-in' });
    act(() => { vi.advanceTimersByTime(CALM_IN_MS); });
    expect(result.current).toMatchObject({ shown: 'new', phase: 'idle', played: 1 });
  });

  it('off: instant, still counted (the pill says it)', () => {
    const { result, rerender } = renderHook(({ v }) => usePixelSwap(v, plays, 'off'), { initialProps: { v: 'old' } });
    rerender({ v: 'new' });
    expect(result.current).toMatchObject({ shown: 'new', phase: 'idle', played: 1 });
  });

  it('a change that is not the agent\'s shows at once, with no motion and no count', () => {
    const { result, rerender } = renderHook(({ v }) => usePixelSwap(v, () => false, 'full'), { initialProps: { v: 'old' } });
    rerender({ v: 'new' });
    expect(result.current).toMatchObject({ shown: 'new', phase: 'idle', played: 0 });
  });

  it('a newer value during the motion is the one revealed', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => usePixelSwap(v, plays, 'full'), { initialProps: { v: 'a' } });
    rerender({ v: 'b' });
    rerender({ v: 'c' });
    act(() => { vi.advanceTimersByTime(PIXEL_HALF_MS); });
    expect(result.current.shown).toBe('c');
    act(() => { vi.advanceTimersByTime(PIXEL_HALF_MS); });
    expect(result.current).toMatchObject({ shown: 'c', phase: 'idle', played: 1 });
  });
});

describe('FIX2 C-L3: a swap never plays across pages, and a second change never restarts the cover', () => {
  type Page = { id: string; rev: number } | null;
  // The page view's rule: only the same page, both loaded, a different revision (the agent's change).
  const samePage = (a: Page, b: Page) => !!a && !!b && a.id === b.id && a.rev !== b.rev;
  const A1: Page = { id: 'a', rev: 1 };
  const A2: Page = { id: 'a', rev: 2 };
  const A3: Page = { id: 'a', rev: 3 };
  const B1: Page = { id: 'b', rev: 1 };

  for (const level of ['full', 'calm'] as const) {
    it(`${level}: another page (or null while loading) during the first half cancels the swap and shows at once`, () => {
      vi.useFakeTimers();
      for (const other of [B1, null]) {
        const { result, rerender } = renderHook(({ v }) => usePixelSwap<Page>(v, samePage, level), { initialProps: { v: A1 as Page } });
        rerender({ v: A2 });
        expect(result.current.phase).toBe(level === 'full' ? 'cover' : 'fade-out');
        act(() => { vi.advanceTimersByTime(100); });
        rerender({ v: other });
        expect(result.current).toMatchObject({ shown: other, phase: 'idle', played: 0 });
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(result.current).toMatchObject({ shown: other, phase: 'idle', played: 0 });
      }
    });
  }

  it('full: another page during the reveal stops the reveal and shows at once', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => usePixelSwap<Page>(v, samePage, 'full'), { initialProps: { v: A1 as Page } });
    rerender({ v: A2 });
    act(() => { vi.advanceTimersByTime(PIXEL_HALF_MS + 100); });
    expect(result.current.phase).toBe('reveal');
    rerender({ v: B1 });
    expect(result.current).toMatchObject({ shown: B1, phase: 'idle' });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current).toMatchObject({ shown: B1, phase: 'idle' });
  });

  it('the old value coming back during the cover cancels the swap', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => usePixelSwap<Page>(v, samePage, 'full'), { initialProps: { v: A1 as Page } });
    rerender({ v: A2 });
    rerender({ v: A1 });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current).toMatchObject({ shown: A1, phase: 'idle', played: 0 });
  });

  it('full: a second agent change during the reveal re-covers from where the reveal is, not from p = 0', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => usePixelSwap<Page>(v, samePage, 'full'), { initialProps: { v: A1 as Page } });
    rerender({ v: A2 });
    act(() => { vi.advanceTimersByTime(PIXEL_HALF_MS); });
    act(() => { vi.advanceTimersByTime(140); }); // the reveal is 40 % through
    expect(result.current).toMatchObject({ shown: A2, phase: 'reveal' });
    rerender({ v: A3 });
    expect(result.current).toMatchObject({ shown: A2, phase: 'cover' });
    expect(result.current.rewindFrom).toBeCloseTo(0.4, 2);
    // The cover is the reveal played backwards: it takes as long as the reveal had run (140 ms).
    act(() => { vi.advanceTimersByTime(139); });
    expect(result.current).toMatchObject({ shown: A2, phase: 'cover' });
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toMatchObject({ shown: A3, phase: 'reveal', rewindFrom: null });
    act(() => { vi.advanceTimersByTime(PIXEL_HALF_MS); });
    expect(result.current).toMatchObject({ shown: A3, phase: 'idle', played: 1 });
  });

  it('pixelFrame: the rewinding cover starts on the very cells the reveal showed, and ends fully covered', () => {
    const at40 = pixelFrame('reveal', 0.4 * PIXEL_HALF_MS, null);
    const rewind0 = pixelFrame('cover', 0, 0.4);
    expect(rewind0).toEqual({ ...at40, done: false });
    expect(at40.covering).toBe(false);
    const end = pixelFrame('cover', 0.4 * PIXEL_HALF_MS, 0.4);
    expect(end.done).toBe(true);
    expect(end.covering).toBe(false);
    expect(end.threshold).toBe(pixelThreshold(0)); // reveal-order at 0 = every cell covered
    // A plain cover / reveal is unchanged.
    expect(pixelFrame('cover', PIXEL_HALF_MS / 2, null)).toEqual({ threshold: pixelThreshold(0.5), covering: true, done: false });
    expect(pixelFrame('reveal', PIXEL_HALF_MS, null)).toEqual({ threshold: pixelThreshold(1), covering: false, done: true });
  });
});
