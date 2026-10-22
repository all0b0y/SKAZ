/*
 * The graph hidden in the field (FX-EFFECTS-SPEC Batch A §3, mock `nodes()`): a jittered grid plus
 * extra nodes on the letters. Seeded, so one size always gives the same nodes.
 */
import { mulberry32 } from '../noise';
import { maskAt, type FieldMask } from './field';

export interface FxNode {
  x: number;
  y: number;
}

export interface NodeOptions {
  /** Grid step, css px; each point is jittered by ±0.4·step. */
  step: number;
  /** Off the letters a grid point is kept with this probability. */
  keep: number;
  /** Tries for extra nodes on the letters (mask > 0.6). */
  extra: number;
  /** An extra node keeps at least this distance (css px) from every other node. */
  gap: number;
  seed: number;
}

export const MAIN_NODES: NodeOptions = { step: 46, keep: 0.55, extra: 140, gap: 26, seed: 21 };

export function generateNodes(mask: FieldMask, w: number, h: number, opts: NodeOptions = MAIN_NODES): FxNode[] {
  const rnd = mulberry32(opts.seed);
  const out: FxNode[] = [];
  const { step } = opts;
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      const jx = x + (rnd() - 0.5) * step * 0.8;
      const jy = y + (rnd() - 0.5) * step * 0.8;
      // Order matters for determinism: the keep roll is drawn only off the letters (as in the mock).
      if (maskAt(mask, jx, jy) > 0.4 || rnd() < opts.keep) out.push({ x: jx, y: jy });
    }
  }
  for (let i = 0; i < opts.extra; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    if (maskAt(mask, x, y) > 0.6 && out.every((n) => Math.hypot(n.x - x, n.y - y) > opts.gap)) out.push({ x, y });
  }
  return out;
}

/** The resting nodes as 2×2 cells on the field grid. */
export function nodeCells(nodes: readonly FxNode[], cols: number, rows: number, cell: number): Uint8Array {
  const cells = new Uint8Array(cols * rows);
  for (const n of nodes) {
    const c = Math.floor(n.x / cell);
    const r = Math.floor(n.y / cell);
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        if (c + dc >= 0 && r + dr >= 0 && c + dc < cols && r + dr < rows) cells[(r + dr) * cols + c + dc] = 1;
      }
    }
  }
  return cells;
}
