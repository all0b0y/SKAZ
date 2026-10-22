/*
 * The dither field as one stateful painter: the mask and nodes cached per size, the live links,
 * the burn-out clock. It draws through an off-screen canvas at one pixel per cell, scaled up without
 * smoothing (the 1-bit look, and ~9× fewer pixels to compute than the css-px canvas).
 */
import type { FxColors } from '../colors';
import { emptyMask, FIELD_ALPHA, renderDither, wordmarkMask, type FieldAlpha, type FieldMask } from './field';
import { burstAlive, connectBurst, drawOverlay, edgeAlive, MAIN_BURST, type BurstOptions, type FxBurst, type FxEdge } from './graph';
import { generateNodes, MAIN_NODES, nodeCells, type FxNode, type NodeOptions } from './nodes';

export interface DitherSceneOptions {
  /** Css px per cell. */
  cell: number;
  /** The word hidden in the field, or null for noise only. */
  word: string | null;
  nodes: NodeOptions;
  burst: BurstOptions;
  alpha: FieldAlpha;
  /** Burn-out length (s). */
  outDuration: number;
}

export const MAIN_SCENE: DitherSceneOptions = {
  cell: 3, word: 'SKAZ', nodes: MAIN_NODES, burst: MAIN_BURST, alpha: FIELD_ALPHA, outDuration: 0.7,
};

/** Height changes up to this keep the layout: the composer growing by a line or two moves nothing. */
export const RELAYOUT_DH = 64;

/**
 * Whether a field laid out for `base` must be laid out again at w × h: on a new width, or when the
 * height moved by more than RELAYOUT_DH px; otherwise the kept layout is cropped or extended.
 */
export function needsRelayout(base: { w: number; h: number } | null, w: number, h: number): boolean {
  return !base || base.w !== w || Math.abs(h - base.h) > RELAYOUT_DH;
}

/** The mask with `rows` rows: cropped at the bottom, or extended with ground (0) rows. */
export function fitMask(mask: FieldMask, rows: number): FieldMask {
  if (rows === mask.rows) return mask;
  const m = new Float32Array(mask.cols * rows);
  m.set(mask.m.subarray(0, Math.min(mask.m.length, m.length)));
  return { cols: mask.cols, rows, cell: mask.cell, m };
}

interface Layout {
  /** The size the word and the nodes were laid out for. */
  w: number;
  h: number;
  family: string;
  /** The word mask as laid out; `mask` is it fitted to the current height. */
  base: FieldMask;
  mask: FieldMask;
  nodes: FxNode[];
  cells: Uint8Array;
  ov: Float32Array;
}

export class DitherScene {
  private layout: Layout | null = null;
  private edges: FxEdge[] = [];
  private bursts: FxBurst[] = [];
  private off: HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private outT0: number | null = null;
  /** The effect clock of the last drawn frame: clicks are stamped with it. */
  private t = 0;

  constructor(private readonly opts: DitherSceneOptions = MAIN_SCENE) {}

  /** Forget the mask (a font arrived): the next frame measures the word again. */
  invalidate(): void { this.layout = null; }

  /** A click at css px (x, y): links grow from it. Ignored before the first frame or while leaving. */
  click(x: number, y: number): void {
    if (!this.layout || this.outT0 !== null) return;
    this.edges.push(...connectBurst(this.layout.nodes, x, y, this.t, this.opts.burst));
    this.bursts.push({ x, y, t0: this.t });
  }

  /** The live links (tests read it). */
  get linkCount(): number { return this.edges.length; }

  /** Something moves faster than the drift: live links or the burn-out (the loop runs at full rate). */
  get busy(): boolean { return this.edges.length > 0 || this.bursts.length > 0 || this.outT0 !== null; }

  /** Drop the links and the burn-out (the view was hidden: nothing of it comes back when shown). */
  reset(): void { this.edges = []; this.bursts = []; this.outT0 = null; }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, colors: FxColors, family: string, leaving: boolean): void {
    this.t = t;
    const layout = this.ensureLayout(w, h, family);
    if (!layout || !this.offCtx || !this.off) return;
    let out: number | null = null;
    if (leaving) {
      // The first leaving frame starts the burn-out; the links and lit nodes go at once.
      if (this.outT0 === null) { this.outT0 = t; this.edges = []; this.bursts = []; }
      out = Math.min(1, (t - this.outT0) / this.opts.outDuration);
    } else {
      this.outT0 = null;
      this.edges = this.edges.filter((e) => edgeAlive(e, t));
      this.bursts = this.bursts.filter((b) => burstAlive(b, t));
      drawOverlay(layout.ov, layout.mask.cols, layout.mask.rows, this.opts.cell, this.edges, this.bursts, t);
    }
    const image = this.image!;
    renderDither(image.data, { mask: layout.mask, nodeCells: layout.cells, ov: layout.ov }, t, out, colors.ink, colors.accent, this.opts.alpha);
    this.offCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.off, 0, 0, layout.mask.cols * this.opts.cell, layout.mask.rows * this.opts.cell);
  }

  private ensureLayout(w: number, h: number, family: string): Layout | null {
    const { cell } = this.opts;
    const cols = Math.ceil(w / cell);
    const rows = Math.ceil(h / cell);
    const l = this.layout;
    if (l && l.family === family && !needsRelayout(l, w, h)) {
      // A small height change (the composer grew a line): the word and the nodes stay put, the
      // field is cropped or extended at the bottom, the live links keep going.
      if (l.mask.rows !== rows && this.offCtx && this.off) {
        l.mask = fitMask(l.base, rows);
        l.cells = nodeCells(l.nodes, cols, rows, cell);
        l.ov = new Float32Array(cols * rows);
        this.off.height = rows;
        this.image = this.offCtx.createImageData(cols, rows);
      }
      return l;
    }
    if (!this.off) {
      this.off = document.createElement('canvas');
      this.offCtx = this.off.getContext('2d');
    }
    if (!this.offCtx) return null;
    const mask = (this.opts.word ? wordmarkMask(w, h, cell, this.opts.word, family) : null) ?? emptyMask(cols, rows, cell);
    const nodes = generateNodes(mask, w, h, this.opts.nodes);
    this.off.width = cols;
    this.off.height = rows;
    this.image = this.offCtx.createImageData(cols, rows);
    // A new layout moves every node: links drawn for the old one would point at nothing.
    this.edges = [];
    this.bursts = [];
    this.layout = { w, h, family, base: mask, mask, nodes, cells: nodeCells(nodes, cols, rows, cell), ov: new Float32Array(cols * rows) };
    return this.layout;
  }
}
