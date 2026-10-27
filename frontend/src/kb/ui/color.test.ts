import { describe, expect, it } from 'vitest';
import { contrast, hueDistance, oklch, over, parseColor } from './color';

describe('parseColor', () => {
  it('reads hex, rgb(a) in both syntaxes, color(srgb) and oklch', () => {
    expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor('#2c2e3180')?.a).toBeCloseTo(128 / 255, 3);
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(10, 14, 13, 0.38)')?.a).toBeCloseTo(0.38);
    expect(parseColor('rgb(0 0 255 / 0.5)')).toEqual({ r: 0, g: 0, b: 1, a: 0.5 });
    expect(parseColor('color(srgb 0.5 0.25 1 / 0.06)')).toEqual({ r: 0.5, g: 0.25, b: 1, a: 0.06 });
    const white = parseColor('oklch(100% 0 0)')!;
    expect(white.r).toBeCloseTo(1, 3);
    expect(white.b).toBeCloseTo(1, 3);
  });

  it('returns null for what it cannot read', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor('var(--kb-text)')).toBeNull();
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe('contrast (WCAG 2.x)', () => {
  it('matches the known reference values', () => {
    const black = parseColor('#000')!;
    const white = parseColor('#fff')!;
    expect(contrast(black, white)).toBeCloseTo(21, 5);
    expect(contrast(parseColor('#777')!, white)).toBeCloseTo(4.48, 2);
    // The measured pair from N10: dark text on dark bg is 15.5:1.
    expect(contrast(parseColor('#f9f8f3')!, parseColor('#1e1f21')!)).toBeCloseTo(15.5, 1);
  });

  it('composites a translucent foreground over the background first', () => {
    const half = parseColor('rgba(0, 0, 0, 0.5)')!;
    const white = parseColor('#fff')!;
    const mixed = over(half, white);
    expect(mixed.r).toBeCloseTo(0.5);
    expect(contrast(half, white)).toBeCloseTo(contrast(mixed, white), 6);
  });
});

describe('oklch / hue distance', () => {
  it('gives lightness in 0..1 and no hue for greys', () => {
    expect(oklch(parseColor('#fff')!).l).toBeCloseTo(1, 3);
    expect(oklch(parseColor('#808080')!).h).toBeNull();
    expect(oklch(parseColor('#2f62b0')!).h).not.toBeNull();
  });

  it('measures the shorter way round the circle', () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(10, 190)).toBe(180);
    expect(hueDistance(null, 30)).toBeNull();
  });
});
