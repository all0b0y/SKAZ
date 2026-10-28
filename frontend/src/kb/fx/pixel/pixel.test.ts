import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PIXEL_CELL, PIXEL_FRINGE, pixelField, pixelThreshold, drawPixelCover } from './pixel';
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
