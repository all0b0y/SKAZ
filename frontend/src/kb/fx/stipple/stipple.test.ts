import { describe, expect, it } from 'vitest';
import {
  CHIP_RADIUS, CHIP_SHIFT, chipLens, lensDots, MIN_K, stepHover, stipplePoints, stripBandX, stripDotStyle, stripGain,
  stripPoints, toastLens, TOAST_DURATION_S, TOAST_SHIFT,
} from './stipple';

describe('stipple points', () => {
  it('are deterministic per size, differ across sizes, and stay inside the box (±jitter)', () => {
    const a = stipplePoints(120, 60);
    expect(stipplePoints(120, 60)).toEqual(a);
    expect(stipplePoints(121, 60)).not.toEqual(a);
    expect(a.length).toBeGreaterThan(40);
    for (const [x, y] of a) {
      expect(x).toBeGreaterThanOrEqual(0.5); expect(x).toBeLessThanOrEqual(120 + 1.5);
      expect(y).toBeGreaterThanOrEqual(0.5); expect(y).toBeLessThanOrEqual(60 + 1.5);
    }
    // ~55 % of a 4.5-px grid.
    const cells = Math.ceil(118 / 4.5) * Math.ceil(58 / 4.5);
    expect(a.length / cells).toBeGreaterThan(0.4);
    expect(a.length / cells).toBeLessThan(0.7);
  });
});

describe('chip lens (hover)', () => {
  const pts = stipplePoints(200, 80);
  it('draws only displaced dots, all within the radius, pushed outward by at most 7 px', () => {
    const lens = chipLens(100, 40, 1);
    const dots = lensDots(pts, lens);
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.length).toBeLessThan(pts.length); // no ground
    for (const d of dots) {
      expect(d.k).toBeGreaterThanOrEqual(MIN_K);
      expect(d.k).toBeLessThanOrEqual(1);
    }
    expect(CHIP_RADIUS).toBe(26);
    expect(CHIP_SHIFT).toBe(7);
    // Compare with the resting position of the same dots: moved away from the centre, ≤ 7 px.
    const inLens = pts.filter(([x, y]) => Math.hypot(x - 100, y - 40) < CHIP_RADIUS && 1 - Math.hypot(x - 100, y - 40) / CHIP_RADIUS >= MIN_K);
    expect(inLens).toHaveLength(dots.length);
    dots.forEach((d, i) => {
      const [x0, y0] = inLens[i]!;
      const moved = Math.hypot(d.x - x0, d.y - y0);
      expect(moved).toBeLessThanOrEqual(CHIP_SHIFT + 1e-9);
      expect(Math.hypot(d.x - 100, d.y - 40)).toBeGreaterThanOrEqual(Math.hypot(x0 - 100, y0 - 40) - 1e-9);
    });
  });
  it('does nothing without hover, and scales with the hover amount', () => {
    expect(lensDots(pts, chipLens(100, 40, 0))).toEqual([]);
    const half = lensDots(pts, chipLens(100, 40, 0.5));
    const full = lensDots(pts, chipLens(100, 40, 1));
    expect(half.length).toBeLessThan(full.length);
    expect(Math.max(...half.map((d) => d.k))).toBeLessThanOrEqual(0.5);
  });
  it('the hover amount eases to its target without overshoot and lands exactly', () => {
    let hv = 0;
    for (let i = 0; i < 60; i++) { const n = stepHover(hv, 1, 1 / 30); expect(n).toBeGreaterThanOrEqual(hv); expect(n).toBeLessThanOrEqual(1); hv = n; }
    expect(hv).toBe(1);
    expect(stepHover(1, 0, 0)).toBe(1);
    expect(stepHover(0.5, 0, 1 / 30)).toBeLessThan(0.5);
  });
});

describe('toast lens (subtle arrival)', () => {
  it('grows the radius 8 → 26 over 0.9 s, fades out by 1 s, then ends', () => {
    expect(toastLens(0, 0, 0)!.radius).toBeCloseTo(8, 6);
    expect(toastLens(0, 0, 0.9)!.radius).toBeCloseTo(26, 6);
    expect(toastLens(0, 0, 0.99)!.radius).toBeCloseTo(26, 6);
    expect(toastLens(0, 0, 0)!.amount).toBe(1);
    expect(toastLens(0, 0, 0.5)!.amount).toBeCloseTo(0.5, 6);
    expect(toastLens(0, 0, TOAST_DURATION_S)).toBeNull();
    expect(toastLens(0, 0, -1)).toBeNull();
    expect(TOAST_DURATION_S).toBe(1);
  });
  it('is gentler than the chip: shift 3 px and k × 0.6', () => {
    const lens = toastLens(40, 20, 0.3)!;
    expect(lens.shift).toBe(TOAST_SHIFT);
    expect(lens.kScale).toBe(0.6);
    const dots = lensDots(stipplePoints(80, 40), lens);
    expect(dots.length).toBeGreaterThan(0);
    expect(Math.max(...dots.map((d) => d.k))).toBeLessThanOrEqual(0.6);
    const chipK = Math.max(...lensDots(stipplePoints(80, 40), chipLens(40, 20, 1)).map((d) => d.k));
    expect(Math.max(...dots.map((d) => d.k))).toBeLessThan(chipK);
  });
});

describe('progress strip (indeterminate band)', () => {
  it('has ~one dot per 2.2 px, inside the 6-px strip, deterministic', () => {
    const p = stripPoints(110, 6);
    expect(p).toHaveLength(50);
    expect(stripPoints(110, 6)).toEqual(p);
    for (const [x, y] of p) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(110); expect(y).toBeGreaterThanOrEqual(1); expect(y).toBeLessThanOrEqual(5); }
  });
  it('the band sweeps from before the left edge to past the right edge and repeats (period 1.4/0.45 s)', () => {
    expect(stripBandX(0, 100)).toBeCloseTo(-20, 6);
    expect(stripBandX(1, 100)).toBeCloseTo(25, 6);
    const period = 1.4 / 0.45;
    expect(stripBandX(period + 0.5, 100)).toBeCloseTo(stripBandX(0.5, 100), 6);
    let prev = -Infinity;
    for (let t = 0; t < period - 0.01; t += 0.1) { const x = stripBandX(t, 100); expect(x).toBeGreaterThan(prev); prev = x; }
  });
  it('gain peaks at the band and falls off; dots are larger and brighter in the band', () => {
    expect(stripGain(50, 50, 100)).toBe(1);
    expect(stripGain(80, 50, 100)).toBeLessThan(stripGain(60, 50, 100));
    expect(stripGain(0, 90, 100)).toBeLessThan(0.01);
    expect(stripGain(5, 5, 0)).toBe(0);
    const rest = stripDotStyle(0);
    const lit = stripDotStyle(1);
    expect(rest).toEqual({ radius: 0.8, alpha: 0.15 });
    expect(lit.radius).toBeCloseTo(1.2, 6);
    expect(lit.alpha).toBeCloseTo(0.95, 6);
  });
});
