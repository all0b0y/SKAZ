/*
 * The small «Dither · Connect» field of an empty state (FX-EFFECTS-SPEC Batch B3, mock `MINI.connect`):
 * faint 2×2 nodes (step 17) on a very faint dithered ground; a click grows accent links over two
 * levels (3 then 2 nearest nodes within 70 px). It reuses the batch-A node generator, burst maths
 * and overlay rasteriser. At rest it is fully static (no loop at all): only a burst animates.
 */
import { bayerAt, valueNoise } from '../noise';
import { rgba, type FxColors, type Rgb } from '../colors';
import { emptyMask, overlayAlpha, overlayOn } from './field';
import { burstAlive, connectBurst, drawOverlay, edgeAlive, type BurstOptions, type FxBurst, type FxEdge } from './graph';
import { generateNodes, type FxNode, type NodeOptions } from './nodes';

/** Css px per cell: the mock's 2-px pixels. */
export const MINI_CELL = 2;
/** Ink alpha at rest (Global rules: quiet): nodes ≤ 0.2, the ground ≤ 0.07. */
export const MINI_ALPHA = { node: 0.2, ground: 0.07 } as const;
/** Level 0: 3 nodes, level 1: 2 each, all within 70 px of their source. */
export const MINI_BURST: BurstOptions = { levels: [3, 2], radius: 70, levelDelay: 0.22 };
/** Step 17, no thinning, no extras — a plain jittered grid. */
export const miniNodeOptions = (w: number, h: number): NodeOptions => ({ step: 17, keep: 1, extra: 0, gap: 0, seed: Math.round(w * 7 + h) });

/** Ground cell on? (mock: vn(x·.05, y·.05+3)·.5 > bayer + .12, at 2-px cells). */
export function miniGroundOn(c: number, r: number): boolean {
  return valueNoise(c * 0.1, r * 0.1 + 3) * 0.5 > bayerAt(c, r) + 0.12;
}

/** The resting layer into RGBA pixels, one per cell: the ground, then the nodes over it. */
export function renderMiniBase(px: Uint8ClampedArray, cols: number, rows: number, nodes: readonly FxNode[], ink: Rgb): void {
  px.fill(0);
  const put = (i: number, a: number) => {
    const o = i * 4;
    px[o] = ink[0]; px[o + 1] = ink[1]; px[o + 2] = ink[2]; px[o + 3] = Math.round(a * 255);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (miniGroundOn(c, r)) put(r * cols + c, MINI_ALPHA.ground);
  }
  for (const n of nodes) {
    const c = Math.floor(n.x / MINI_CELL);
    const r = Math.floor(n.y / MINI_CELL);
    if (c >= 0 && r >= 0 && c < cols && r < rows) put(r * cols + c, MINI_ALPHA.node);
  }
}

/** The nodes for a size, deterministic (the scene and the tests share it). */
export function miniNodes(w: number, h: number): FxNode[] {
  const cols = Math.ceil(w / MINI_CELL);
  const rows = Math.ceil(h / MINI_CELL);
  return generateNodes(emptyMask(cols, rows, MINI_CELL), w, h, miniNodeOptions(w, h));
}

interface Layout {
  w: number;
  h: number;
  cols: number;
  rows: number;
  nodes: FxNode[];
  base: HTMLCanvasElement;
  ov: Float32Array;
  inkKey: string;
}

/** The painter of one mini field: caches the layout per size, owns the live links. */
export class MiniScene {
  private layout: Layout | null = null;
  private edges: FxEdge[] = [];
  private bursts: FxBurst[] = [];
  private pending: Array<[number, number]> = [];
  private t = 0;

  /** A click at css px (x, y). Ignored before the first frame (no nodes yet). */
  click(x: number, y: number): void {
    if (this.layout) this.pending.push([x, y]);
  }

  get linkCount(): number { return this.edges.length; }

  /** Draws a frame; true while a burst is still alive (the caller keeps the loop running). */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, colors: FxColors): boolean {
    // The loop restarts at t = 0 for every burst: links stamped on the old clock are done anyway.
    if (t < this.t) { this.edges = []; this.bursts = []; }
    this.t = t;
    const layout = this.ensureLayout(w, h, colors.ink);
    if (!layout) return false;
    for (const [x, y] of this.pending.splice(0)) {
      this.edges.push(...connectBurst(layout.nodes, x, y, t, MINI_BURST));
      this.bursts.push({ x, y, t0: t });
    }
    this.edges = this.edges.filter((e) => edgeAlive(e, t));
    this.bursts = this.bursts.filter((b) => burstAlive(b, t));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layout.base, 0, 0, layout.cols * MINI_CELL, layout.rows * MINI_CELL);
    if (this.edges.length === 0 && this.bursts.length === 0) return false;
    const { cols, rows, ov } = layout;
    drawOverlay(ov, cols, rows, MINI_CELL, this.edges, this.bursts, t);
    ctx.fillStyle = rgba(colors.accent, 1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const o = ov[r * cols + c]!;
        if (!overlayOn(o, c, r)) continue;
        ctx.globalAlpha = overlayAlpha(o);
        ctx.fillRect(c * MINI_CELL, r * MINI_CELL, MINI_CELL, MINI_CELL);
      }
    }
    ctx.globalAlpha = 1;
    return true;
  }

  private ensureLayout(w: number, h: number, ink: Rgb): Layout | null {
    const key = ink.join(',');
    const l = this.layout;
    if (l && l.w === w && l.h === h && l.inkKey === key) return l;
    const cols = Math.ceil(w / MINI_CELL);
    const rows = Math.ceil(h / MINI_CELL);
    if (cols <= 0 || rows <= 0) return null;
    const base = l?.base ?? document.createElement('canvas');
    const bctx = base.getContext('2d');
    if (!bctx) return null;
    base.width = cols;
    base.height = rows;
    const nodes = miniNodes(w, h);
    const image = bctx.createImageData(cols, rows);
    renderMiniBase(image.data, cols, rows, nodes, ink);
    bctx.putImageData(image, 0, 0);
    // A new size moves every node: links drawn for the old layout would point at nothing.
    if (!l || l.w !== w || l.h !== h) { this.edges = []; this.bursts = []; this.pending = []; }
    this.layout = { w, h, cols, rows, nodes, base, ov: new Float32Array(cols * rows), inkKey: key };
    return this.layout;
  }
}
