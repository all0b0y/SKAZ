import { describe, expect, it } from 'vitest';
import { squarify } from './treemap';

describe('Explore treemap layout (treemap.ts)', () => {
  it('squarifies items preserving total area and staying within bounds', () => {
    const items = [
      { id: 'a', weight: 239 },
      { id: 'b', weight: 128 },
      { id: 'c', weight: 29 },
      { id: 'd', weight: 16 },
    ];
    const rects = squarify(items, 0, 0, 600, 400);
    expect(rects).toHaveLength(4);
    expect(rects.reduce((sum, r) => sum + r.w * r.h, 0)).toBeCloseTo(600 * 400, 1);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(600.01);
      expect(r.y + r.h).toBeLessThanOrEqual(400.01);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
  });

  it('gives each item an area in proportion to its weight', () => {
    const rects = squarify([{ id: 'big', weight: 300 }, { id: 'small', weight: 100 }], 0, 0, 400, 300);
    const area = (id: string) => { const r = rects.find((x) => x.id === id)!; return r.w * r.h; };
    expect(area('big') / area('small')).toBeCloseTo(3, 5);
  });

  it('returns nothing for no items, no room, or items without weight', () => {
    expect(squarify([], 0, 0, 500, 300)).toEqual([]);
    expect(squarify([{ id: 'a', weight: 10 }], 0, 0, 0, 300)).toEqual([]);
    expect(squarify([{ id: 'a', weight: 10 }], 0, 0, 300, 0)).toEqual([]);
    expect(squarify([{ id: 'a', weight: 0 }], 0, 0, 300, 300)).toEqual([]);
  });

  it('fills the whole box with one item', () => {
    expect(squarify([{ id: 'only', weight: 5 }], 10, 20, 300, 200)).toEqual([{ id: 'only', weight: 5, x: 10, y: 20, w: 300, h: 200 }]);
  });
});
