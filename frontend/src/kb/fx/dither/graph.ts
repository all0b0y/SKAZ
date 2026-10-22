/*
 * «Connect on click» (FX-EFFECTS-SPEC Batch A §4, mock `connectBurst`/`ovLine`/`ovNode`): the click
 * becomes a node and links grow breadth-first to the nearest unused nodes. Pure: the overlay is a
 * Float32Array of cell intensities the field renderer turns into accent pixels.
 */
import type { FxNode } from './nodes';

export interface BurstOptions {
  /** Links per frontier node on each level; its length is the depth. */
  levels: readonly number[];
  /** Only nodes closer than this (css px) are linked. */
  radius: number;
  /** Each level starts this much later (s). */
  levelDelay: number;
}

export const MAIN_BURST: BurstOptions = { levels: [4, 2, 2], radius: 150, levelDelay: 0.22 };

export interface FxEdge {
  ax: number; ay: number; bx: number; by: number;
  /** Start time (s, in the effect's clock) and grow duration (s). */
  t0: number;
  dur: number;
  lvl: number;
}

export interface FxBurst {
  x: number;
  y: number;
  t0: number;
}

/** Full intensity until this age (s), then a fade of the same length. */
export const EDGE_HOLD = 1.1;
export const EDGE_FADE = 1.1;

/** The links of one click at (x, y), time t. */
export function connectBurst(nodes: readonly FxNode[], x: number, y: number, t: number, opts: BurstOptions = MAIN_BURST): FxEdge[] {
  const used = new Set<FxNode>();
  const edges: FxEdge[] = [];
  let frontier: FxNode[] = [{ x, y }];
  opts.levels.forEach((count, lvl) => {
    const next: FxNode[] = [];
    for (const f of frontier) {
      const near = nodes
        .filter((n) => !used.has(n))
        .map((n) => [n, Math.hypot(n.x - f.x, n.y - f.y)] as const)
        .filter(([, d]) => d < opts.radius)
        .sort((a, b) => a[1] - b[1])
        .slice(0, count);
      for (const [n, d] of near) {
        used.add(n);
        edges.push({ ax: f.x, ay: f.y, bx: n.x, by: n.y, t0: t + lvl * opts.levelDelay, dur: 0.16 + d / 900, lvl });
        next.push(n);
      }
    }
    frontier = next;
  });
  return edges;
}

/** An edge's intensity at `age` seconds after its start: 1, then a linear fade to 0. */
export function edgeIntensity(age: number): number {
  if (age < 0) return 0;
  return age < EDGE_HOLD ? 1 : Math.max(0, 1 - (age - EDGE_HOLD) / EDGE_FADE);
}

/** Still visible at time t (the mock's lifetimes, a little past the fade so nothing pops). */
export const edgeAlive = (e: FxEdge, t: number): boolean => t - e.t0 < EDGE_HOLD + EDGE_FADE + 0.1 + e.lvl * 0.2;
export const burstAlive = (b: FxBurst, t: number): boolean => t - b.t0 < 2.4;
/** The clicked node: full, then gone over 1.2 s after the first second. */
export const burstIntensity = (age: number): number => Math.max(0, 1 - Math.max(0, age - 1) / 1.2);

/** A 1-cell Bresenham line into the overlay; `prog` = the drawn fraction from (x0, y0). */
export function ovLine(ov: Float32Array, cols: number, rows: number, cell: number,
  x0: number, y0: number, x1: number, y1: number, v: number, prog = 1): void {
  let c0 = Math.floor(x0 / cell);
  let r0 = Math.floor(y0 / cell);
  const c1 = Math.floor(x0 / cell + ((x1 - x0) / cell) * prog);
  const r1 = Math.floor(y0 / cell + ((y1 - y0) / cell) * prog);
  const dc = Math.abs(c1 - c0);
  const dr = -Math.abs(r1 - r0);
  const sc = c0 < c1 ? 1 : -1;
  const sr = r0 < r1 ? 1 : -1;
  let err = dc + dr;
  for (let n = 0; n < 400; n++) {
    if (c0 >= 0 && r0 >= 0 && c0 < cols && r0 < rows) {
      const i = r0 * cols + c0;
      if (v > ov[i]!) ov[i] = v;
    }
    if (c0 === c1 && r0 === r1) break;
    const e2 = 2 * err;
    if (e2 >= dr) { err += dr; c0 += sc; }
    if (e2 <= dc) { err += dc; r0 += sr; }
  }
}

/** A size×size block of cells (2 = a reached node, 3 = the clicked node, centred). */
export function ovNode(ov: Float32Array, cols: number, rows: number, cell: number, x: number, y: number, v: number, size = 2): void {
  const c = Math.floor(x / cell) - (size > 2 ? 1 : 0);
  const r = Math.floor(y / cell) - (size > 2 ? 1 : 0);
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc >= 0 && rr >= 0 && cc < cols && rr < rows) {
        const i = rr * cols + cc;
        if (v > ov[i]!) ov[i] = v;
      }
    }
  }
}

/** Rasterise the live links and clicked nodes at time t into `ov` (cleared first). */
export function drawOverlay(ov: Float32Array, cols: number, rows: number, cell: number,
  edges: readonly FxEdge[], bursts: readonly FxBurst[], t: number): void {
  ov.fill(0);
  for (const e of edges) {
    const age = t - e.t0;
    if (age < 0) continue;
    const prog = Math.min(1, age / e.dur);
    const v = edgeIntensity(age);
    ovLine(ov, cols, rows, cell, e.ax, e.ay, e.bx, e.by, v * 0.95, prog);
    if (prog >= 1) ovNode(ov, cols, rows, cell, e.bx, e.by, v, 2);
  }
  for (const b of bursts) ovNode(ov, cols, rows, cell, b.x, b.y, burstIntensity(t - b.t0), 3);
}
