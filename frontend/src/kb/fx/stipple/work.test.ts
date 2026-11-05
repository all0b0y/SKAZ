import { describe, expect, it } from 'vitest';
import { globeDots, ringDots } from './work';

describe('N9 work indicators use the accepted stippling geometry', () => {
  it('the completed globe has one fading glow, then a fixed frame instead of continuing to rotate', () => {
    expect(globeDots(24, 24, 1, 1)).toEqual(globeDots(24, 24, 999, 1));
    expect(globeDots(24, 24, 1, 0)).not.toEqual(globeDots(24, 24, 1, 1));
  });
  it.each([globeDots, ringDots])('is deterministic, moves with time, and keeps valid dots at every supported size', (draw) => {
    for (const size of [12, 16, 24, 64]) {
      const frame = draw(size, size, 1.5);
      expect(frame.length).toBeGreaterThan(0);
      expect(draw(size, size, 1.5)).toEqual(frame);
      expect(draw(size, size, 2)).not.toEqual(frame);
      for (const d of frame) {
        expect([d.x, d.y, d.radius, d.alpha, d.k].every(Number.isFinite)).toBe(true);
        expect(d.x).toBeGreaterThanOrEqual(0);
        expect(d.x).toBeLessThanOrEqual(size);
        expect(d.y).toBeGreaterThanOrEqual(0);
        expect(d.y).toBeLessThanOrEqual(size);
        expect(d.radius).toBeGreaterThan(0);
        expect(d.alpha).toBeGreaterThanOrEqual(0);
        expect(d.alpha).toBeLessThanOrEqual(1);
      }
    }
    expect(draw(0, 0, 0)).toEqual([]);
  });
});
