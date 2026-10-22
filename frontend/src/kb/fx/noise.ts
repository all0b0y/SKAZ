/*
 * Deterministic noise for the canvas effects (FX-EFFECTS-SPEC «Core module API»). Pure maths, no DOM:
 * every effect is seeded, so the same size always draws the same field and tests can pin it.
 */

/** Seeded PRNG (mulberry32): the same seed gives the same sequence, values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash → [0, 1). Coordinates are truncated to integers. */
export function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise on the integer lattice (smoothstep blend of the four corner hashes), [0, 1). */
export function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Two octaves: the soft drift the dither field breathes with. */
export function fbm(x: number, y: number): number {
  return valueNoise(x, y) * 0.65 + valueNoise(x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.35;
}

/** Ordered-dither thresholds: the standard 4×4 Bayer matrix as (v + 0.5) / 16, row-major. */
export const BAYER4: readonly number[] = Object.freeze(
  [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16),
);

/** The threshold of cell (c, r). */
export function bayerAt(c: number, r: number): number {
  return BAYER4[(r & 3) * 4 + (c & 3)]!;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
