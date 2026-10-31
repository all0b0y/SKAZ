import type { Rgb } from '../colors';
import { rgba } from '../colors';
import { bayerAt, valueNoise } from '../noise';
import { PIXEL_HALF_MS, type PixelPhase } from './usePixelSwap';

/*
 * Stage 6 B6 — PixelTransition (DESIGN-SYSTEM.md decision 30; demo .dev/ui-blocks/motion6 motion-v1 B6).
 * When the agent rewrites the open wiki page, the old text dissolves in our dither cells and the new one
 * is revealed the same way. Each 4-px cell has a threshold = 0.6·y + 0.24·value noise + 0.16·Bayer 4×4
 * (normalised), so the front moves down the page, ragged and ordered like the rest of the SKAZ dither.
 * Cells are painted in the pane colour; a thin fringe at the front (6 % of the range) in the FX accent.
 */

export const PIXEL_CELL = 4;
export const PIXEL_FRINGE = 0.06;

export interface PixelField {
  nx: number;
  ny: number;
  /** Per cell, row-major, in [0, 1]: the moment the front reaches it. */
  values: number[];
}

export function pixelField(nx: number, ny: number): PixelField {
  const values = new Array<number>(nx * ny);
  let max = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = 0.6 * (y / ny) + 0.24 * valueNoise(x * 0.09, y * 0.09) + 0.16 * bayerAt(x, y);
      values[y * nx + x] = v;
      if (v > max) max = v;
    }
  }
  if (max > 0) for (let i = 0; i < values.length; i++) values[i] = values[i]! / max;
  return { nx, ny, values };
}

/** The front at progress p (0..1) of one half: from just below every cell to just above every cell. */
export function pixelThreshold(p: number): number {
  return p * 1.2 - 0.1;
}

/**
 * What one frame draws, `elapsed` ms into a phase. A plain cover runs the front forward in cover order;
 * a cover that interrupts a reveal (`rewindFrom` = how far the reveal had got, 0..1) plays that reveal
 * BACKWARDS from where it stood, so the cells already on screen stay put and the page re-covers in the
 * reverse order (FIX2 C-L3: never a jump back to an empty cover at p = 0). `done` = this phase's
 * picture is complete (the swap timer in usePixelSwap ends it).
 */
export function pixelFrame(phase: PixelPhase, elapsed: number, rewindFrom: number | null): { threshold: number; covering: boolean; done: boolean } {
  const t = Math.max(0, elapsed) / PIXEL_HALF_MS;
  if (phase === 'cover' && rewindFrom !== null) {
    const p = Math.max(0, rewindFrom - t);
    return { threshold: pixelThreshold(p), covering: false, done: p <= 0 };
  }
  const p = Math.min(1, t);
  return { threshold: pixelThreshold(p), covering: phase === 'cover', done: p >= 1 };
}

export interface PixelColors {
  pane: Rgb;
  accent: Rgb;
}

/**
 * One frame. `cover`: the cells the front has passed are painted (the old text disappears);
 * otherwise the cells the front has NOT passed yet stay painted (the new text appears).
 */
export function drawPixelCover(ctx: CanvasRenderingContext2D | null, field: PixelField, w: number, h: number, threshold: number,
  cover: boolean, colors: PixelColors): void {
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const pane = rgba(colors.pane, 1);
  const fringe = rgba(colors.accent, 0.5);
  const { nx, ny, values } = field;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = values[y * nx + x]!;
      const on = cover ? v < threshold : v >= threshold;
      if (!on) continue;
      ctx.fillStyle = pane;
      ctx.fillRect(x * PIXEL_CELL, y * PIXEL_CELL, PIXEL_CELL, PIXEL_CELL);
      if (Math.abs(v - threshold) < PIXEL_FRINGE) {
        ctx.fillStyle = fringe;
        ctx.fillRect(x * PIXEL_CELL, y * PIXEL_CELL, PIXEL_CELL, PIXEL_CELL);
      }
    }
  }
}
