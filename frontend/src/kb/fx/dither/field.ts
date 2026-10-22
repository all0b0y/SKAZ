/*
 * The 1-bit dither field (FX-EFFECTS-SPEC Batch A §2, mock empty-chat-v2 `mask`/`drawField`/`FX.dither`).
 * The field lives on a cell grid (3 css px per cell on the main screen); everything here except
 * `wordmarkMask` is pure, so the alpha rules are unit-tested without a canvas.
 */
import { BAYER4, clamp, fbm } from '../noise';
import type { Rgb } from '../colors';

/** Coverage of the wordmark per cell, 0..1, row-major. */
export interface FieldMask {
  cols: number;
  rows: number;
  /** Css px per cell. */
  cell: number;
  m: Float32Array;
}

export interface FieldAlpha {
  /** Cells on the letters (mask > 0.25). */
  letter: number;
  /** The ground around them. */
  ground: number;
}

/** Quiet at rest (Global rules): ink at 12–13.5 %. */
export const FIELD_ALPHA: FieldAlpha = { letter: 0.135, ground: 0.12 };
/** Cells with more coverage than this count as letter cells for alpha. */
export const LETTER_MASK = 0.25;

export function emptyMask(cols: number, rows: number, cell: number): FieldMask {
  return { cols, rows, cell, m: new Float32Array(cols * rows) };
}

/** Mask value under a css-px point (clamped to the grid). */
export function maskAt(mask: FieldMask, x: number, y: number): number {
  const c = clamp(Math.floor(x / mask.cell), 0, mask.cols - 1);
  const r = clamp(Math.floor(y / mask.cell), 0, mask.rows - 1);
  return mask.m[r * mask.cols + c] ?? 0;
}

/**
 * The word drawn at one pixel per cell: width 74 % of the area, the size capped at half the height,
 * centred horizontally with its middle at 47 %. Needs a 2D canvas; null where there is none.
 */
export function wordmarkMask(w: number, h: number, cell: number, word: string, family: string): FieldMask | null {
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  if (cols <= 0 || rows <= 0) return null;
  const oc = document.createElement('canvas');
  oc.width = cols;
  oc.height = rows;
  const c = oc.getContext('2d', { willReadFrequently: true });
  if (!c) return null;
  c.fillStyle = '#000';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `700 100px ${family}`;
  const mw = c.measureText(word).width || 1;
  const fs = Math.min((100 * cols * 0.74) / mw, rows * 0.5);
  c.font = `700 ${fs}px ${family}`;
  c.fillText(word, cols / 2, rows * 0.47);
  const data = c.getImageData(0, 0, cols, rows).data;
  const mask = emptyMask(cols, rows, cell);
  for (let i = 0; i < mask.m.length; i++) mask.m[i] = data[i * 4 + 3]! / 255;
  return mask;
}

/** Field level of a cell: the letters plus the brighter crests of the noise (`n` = fbm, 0..1). */
export function fieldLevel(mask: number, n: number): number {
  return mask * (0.42 + 0.55 * n) + (n > 0.52 ? (n - 0.52) * 0.85 : 0);
}

/** Ink alpha of a lit field cell. */
export function fieldAlpha(mask: number, alpha: FieldAlpha = FIELD_ALPHA): number {
  return mask > LETTER_MASK ? alpha.letter : alpha.ground;
}

/** A cell is on when its level passes its Bayer threshold. */
export function fieldCellOn(level: number, c: number, r: number): boolean {
  return level > BAYER4[(r & 3) * 4 + (c & 3)]!;
}

/**
 * The first-message «burn out» (§6) at progress p = 0..1: the gain rises ×(1 + 5p) for p < 0.25, then
 * falls to 0; the alpha fades to half. No transition: gain 1, fade 1.
 */
export function burnOut(p: number | null): { gain: number; fade: number } {
  if (p === null) return { gain: 1, fade: 1 };
  const gain = p < 0.25 ? 1 + p * 5 : Math.max(0, 1 - (p - 0.25) / 0.75) * 2.25;
  return { gain, fade: 1 - p * 0.5 };
}

/** Overlay (links, lit nodes) wins over the field where it beats ~85 % of the threshold. */
export function overlayOn(ov: number, c: number, r: number): boolean {
  return ov > 0.02 && ov > BAYER4[(r & 3) * 4 + (c & 3)]! * 0.85;
}

export const overlayAlpha = (ov: number): number => Math.min(1, 0.3 + 0.5 * ov);

export interface DitherLayers {
  mask: FieldMask;
  /** 1 where a resting node sits (2×2 cells per node). */
  nodeCells: Uint8Array;
  /** Link / lit-node intensity per cell, 0..1 (accent). */
  ov: Float32Array;
}

/**
 * One frame of the field into RGBA pixels, one pixel per cell (blitted ×cell, no smoothing).
 * `out` = burn-out progress or null; during it the overlay and the nodes are gone.
 */
export function renderDither(px: Uint8ClampedArray, layers: DitherLayers, t: number, out: number | null,
  ink: Rgb, accent: Rgb, alpha: FieldAlpha = FIELD_ALPHA): void {
  const { mask, nodeCells, ov } = layers;
  const { cols, rows, m } = mask;
  const { gain, fade } = burnOut(out);
  px.fill(0);
  const put = (i: number, col: Rgb, a: number) => {
    const o = i * 4;
    px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = Math.min(1, a) * 255;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const mm = m[i]!;
      if (out === null) {
        const o = ov[i]!;
        if (overlayOn(o, c, r)) { put(i, accent, overlayAlpha(o)); continue; }
        if (nodeCells[i]) { put(i, ink, fieldAlpha(mm, alpha) * 1.25); continue; }
      }
      const level = fieldLevel(mm, fbm(c * 0.035 + t * 0.012, r * 0.035)) * gain;
      if (fieldCellOn(level, c, r)) put(i, ink, fieldAlpha(mm, alpha) * fade);
    }
  }
}
