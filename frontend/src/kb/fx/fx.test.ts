import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAYER4, bayerAt, fbm, hash2, mulberry32, valueNoise } from './noise';
import { mixRgb, parseColor, readFxColors, rgba } from './colors';
import { burnOut, emptyMask, FIELD_ALPHA, fieldAlpha, fieldCellOn, fieldLevel, maskAt, renderDither, type FieldMask } from './dither/field';
import { generateNodes, MAIN_NODES, nodeCells } from './dither/nodes';
import { connectBurst, drawOverlay, edgeIntensity, MAIN_BURST, ovLine, ovNode, type FxEdge } from './dither/graph';
import { DitherScene, fitMask, needsRelayout, RELAYOUT_DH } from './dither/scene';
import { CONNECT_EDGES, CONNECT_NODES, CONNECT_STILL_T, connectState } from './indicators/connect';

const filled = (cols: number, rows: number, cell: number, v: number): FieldMask => {
  const m = emptyMask(cols, rows, cell);
  m.m.fill(v);
  return m;
};

describe('fx/noise', () => {
  it('mulberry32 is deterministic per seed and stays in [0, 1)', () => {
    const a = mulberry32(21);
    const b = mulberry32(21);
    const xs = Array.from({ length: 200 }, () => a());
    expect(Array.from({ length: 200 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(22)()).not.toBe(xs[0]);
    // Not stuck in a corner: the mean of a uniform sample is near 0.5.
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeGreaterThan(0.4);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeLessThan(0.6);
  });

  it('hash2 is a pure lattice hash in [0, 1); value noise meets it at the lattice points', () => {
    expect(hash2(3, 7)).toBe(hash2(3, 7));
    expect(hash2(3, 7)).not.toBe(hash2(7, 3));
    for (let i = -20; i < 20; i++) {
      const h = hash2(i, i * 3);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      expect(valueNoise(i, i * 3)).toBeCloseTo(h, 12);
    }
    // Between lattice points it blends smoothly (bounded by the corners).
    const v = valueNoise(2.5, 4.5);
    const corners = [hash2(2, 4), hash2(3, 4), hash2(2, 5), hash2(3, 5)];
    expect(v).toBeGreaterThanOrEqual(Math.min(...corners));
    expect(v).toBeLessThanOrEqual(Math.max(...corners));
  });

  it('fbm is the spec blend of two octaves', () => {
    for (const [x, y] of [[0.3, 1.7], [12.1, 4.4], [-3.2, 8.9]] as const) {
      expect(fbm(x, y)).toBeCloseTo(valueNoise(x, y) * 0.65 + valueNoise(x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.35, 12);
    }
  });

  it('BAYER4 is the standard 4×4 matrix as (v + 0.5) / 16, read-only', () => {
    expect(BAYER4).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16));
    expect([...BAYER4].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => (i + 0.5) / 16));
    expect(Object.isFrozen(BAYER4)).toBe(true);
    expect(bayerAt(5, 6)).toBe(BAYER4[(6 & 3) * 4 + (5 & 3)]);
  });
});

describe('fx/colors', () => {
  it('reads hex and rgb tokens, mixes and formats', () => {
    expect(parseColor('#5a7420')).toEqual([90, 116, 32]);
    expect(parseColor(' #fff ')).toEqual([255, 255, 255]);
    expect(parseColor('rgb(191, 164, 244)')).toEqual([191, 164, 244]);
    expect(parseColor('var(--x)')).toBeNull();
    expect(mixRgb([0, 0, 0], [200, 100, 50], 0.5)).toEqual([100, 50, 25]);
    expect(rgba([10.7, 20, 30], 1.4)).toBe('rgba(10,20,30,1.000)');
    expect(rgba([10, 20, 30], -1)).toBe('rgba(10,20,30,0.000)');
  });

  it('readFxColors takes ink / accent from the tokens, with light fallbacks (no painter reads the pane)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(readFxColors(el)).toEqual({ ink: [44, 46, 49], accent: [90, 116, 32] });
    el.style.setProperty('--kb-text', '#f9f8f3');
    el.style.setProperty('--kb-fx-accent', '#bfa4f4');
    expect(readFxColors(el)).toEqual({ ink: [249, 248, 243], accent: [191, 164, 244] });
    el.remove();
  });
});

describe('fx/dither field', () => {
  it('level: letters plus the noise crests; alpha: letter cells 0.135, ground 0.12', () => {
    expect(fieldLevel(0, 0.5)).toBe(0);
    expect(fieldLevel(0, 0.62)).toBeCloseTo(0.1 * 0.85, 12);
    expect(fieldLevel(1, 0.5)).toBeCloseTo(0.42 + 0.275, 12);
    expect(fieldAlpha(0.26)).toBe(0.135);
    expect(fieldAlpha(0.25)).toBe(0.12);
    expect(fieldAlpha(0)).toBe(FIELD_ALPHA.ground);
    // Ordered dither: on when the level passes the cell's Bayer threshold.
    expect(fieldCellOn(0.04, 0, 0)).toBe(true); // threshold 0.03125
    expect(fieldCellOn(0.04, 1, 0)).toBe(false); // threshold 0.53125
  });

  it('burn-out: gain ×(1 + 5p) up to p = 0.25, then down to 0; alpha to half', () => {
    expect(burnOut(null)).toEqual({ gain: 1, fade: 1 });
    expect(burnOut(0.2).gain).toBeCloseTo(2, 12);
    expect(burnOut(0.25).gain).toBeCloseTo(2.25, 12);
    expect(burnOut(1)).toEqual({ gain: 0, fade: 0.5 });
  });

  it('renders ink cells at the field alpha, nodes ×1.25, links in accent; nothing but the field while leaving', () => {
    const ink = [10, 20, 30] as const;
    const accent = [200, 100, 0] as const;
    const mask = filled(8, 8, 3, 1);
    const ov = new Float32Array(64);
    const cells = new Uint8Array(64);
    ov[0] = 1; // a link cell
    cells[9] = 1; // a resting node cell
    const px = new Uint8ClampedArray(64 * 4);
    renderDither(px, { mask, nodeCells: cells, ov }, 0, null, ink, accent);
    expect([...px.slice(0, 4)]).toEqual([200, 100, 0, Math.round(0.8 * 255)]);
    expect([...px.slice(36, 40)]).toEqual([10, 20, 30, Math.round(0.135 * 1.25 * 255)]);
    const alphas = new Set<number>();
    for (let i = 0; i < 64; i++) if (i !== 0 && i !== 9 && px[i * 4 + 3]) alphas.add(px[i * 4 + 3]!);
    expect([...alphas]).toEqual([Math.round(0.135 * 255)]);
    // Ground only (no letters): the quieter alpha.
    renderDither(px, { mask: filled(8, 8, 3, 0), nodeCells: new Uint8Array(64), ov: new Float32Array(64) }, 40, null, ink, accent);
    for (let i = 0; i < 64; i++) expect([0, Math.round(0.12 * 255)]).toContain(px[i * 4 + 3]);
    // Leaving: links and nodes are gone at once; at the end the field is burnt out.
    renderDither(px, { mask, nodeCells: cells, ov }, 0, 0.1, ink, accent);
    expect(px[0]).not.toBe(200);
    renderDither(px, { mask, nodeCells: cells, ov }, 0, 1, ink, accent);
    expect(px.every((v) => v === 0)).toBe(true);
  });
});

describe('fx/dither nodes', () => {
  it('a seeded jittered grid: the same size gives the same nodes, each within ±0.4·step of its point', () => {
    const mask = emptyMask(Math.ceil(600 / 3), Math.ceil(400 / 3), 3);
    const a = generateNodes(mask, 600, 400);
    expect(generateNodes(mask, 600, 400)).toEqual(a);
    const step = MAIN_NODES.step;
    for (const n of a) {
      const gx = Math.floor(n.x / step) * step + step / 2;
      const gy = Math.floor(n.y / step) * step + step / 2;
      expect(Math.abs(n.x - gx)).toBeLessThanOrEqual(0.4 * step + 1e-9);
      expect(Math.abs(n.y - gy)).toBeLessThanOrEqual(0.4 * step + 1e-9);
    }
    // Off the letters about 55 % of the grid stays (no extras without letters).
    const grid = Math.ceil((600 - step / 2) / step) * Math.ceil((400 - step / 2) / step);
    expect(a.length / grid).toBeGreaterThan(0.4);
    expect(a.length / grid).toBeLessThan(0.7);
  });

  it('on the letters every grid point stays, plus extras at least 26 px from all earlier nodes', () => {
    const w = 600;
    const h = 400;
    const mask = filled(w / 3, Math.ceil(h / 3), 3, 1);
    const nodes = generateNodes(mask, w, h);
    const step = MAIN_NODES.step;
    const grid = Math.ceil((w - step / 2) / step) * Math.ceil((h - step / 2) / step);
    expect(nodes.length).toBeGreaterThan(grid);
    expect(nodes.length).toBeLessThanOrEqual(grid + MAIN_NODES.extra);
    for (let i = grid; i < nodes.length; i++) {
      for (let j = 0; j < i; j++) expect(Math.hypot(nodes[i]!.x - nodes[j]!.x, nodes[i]!.y - nodes[j]!.y)).toBeGreaterThan(26);
    }
    expect(maskAt(mask, -5, 9999)).toBe(1); // clamped to the grid
  });

  it('each node is 2×2 cells on the grid', () => {
    const cells = nodeCells([{ x: 4, y: 7 }], 5, 5, 3);
    expect([...cells].flatMap((v, i) => (v ? [i] : []))).toEqual([2 * 5 + 1, 2 * 5 + 2, 3 * 5 + 1, 3 * 5 + 2]);
  });
});

describe('fx/dither connect on click', () => {
  // A 20 px lattice: plenty of nodes inside and outside the 150 px radius.
  const lattice = Array.from({ length: 31 * 31 }, (_, i) => ({ x: (i % 31) * 20, y: Math.floor(i / 31) * 20 }));

  it('three BFS levels: 4 links from the click, then 2 per reached node, each node once, all within 150 px', () => {
    const edges = connectBurst(lattice, 301, 299, 10);
    const by = (lvl: number) => edges.filter((e) => e.lvl === lvl);
    expect(by(0)).toHaveLength(4);
    expect(by(0).every((e) => e.ax === 301 && e.ay === 299)).toBe(true);
    expect(by(1)).toHaveLength(8);
    expect(by(2)).toHaveLength(16);
    const targets = edges.map((e) => `${e.bx},${e.by}`);
    expect(new Set(targets).size).toBe(targets.length);
    for (const e of edges) {
      const d = Math.hypot(e.bx - e.ax, e.by - e.ay);
      expect(d).toBeLessThan(MAIN_BURST.radius);
      expect(e.t0).toBeCloseTo(10 + e.lvl * 0.22, 12);
      expect(e.dur).toBeCloseTo(0.16 + d / 900, 12);
    }
    // Every level-1 link starts at a level-0 target.
    const l0 = new Set(by(0).map((e) => `${e.bx},${e.by}`));
    expect(by(1).every((e) => l0.has(`${e.ax},${e.ay}`))).toBe(true);
  });

  it('nothing in reach, nothing linked; a lone node gets one link', () => {
    expect(connectBurst([{ x: 0, y: 0 }], 400, 400, 0)).toEqual([]);
    expect(connectBurst([{ x: 100, y: 0 }], 0, 0, 0)).toHaveLength(1);
  });

  it('links hold 1.1 s, then fade over 1.1 s', () => {
    expect(edgeIntensity(-0.1)).toBe(0);
    expect(edgeIntensity(0)).toBe(1);
    expect(edgeIntensity(1.09)).toBe(1);
    expect(edgeIntensity(1.65)).toBeCloseTo(0.5, 12);
    expect(edgeIntensity(2.2)).toBe(0);
  });

  it('rasterises 1-cell lines that grow with progress, 2×2 reached nodes and the 3×3 click', () => {
    const ov = new Float32Array(10 * 10);
    ovLine(ov, 10, 10, 3, 1, 1, 28, 1, 0.9, 0);
    expect([...ov].filter((v) => v > 0)).toHaveLength(1);
    ovLine(ov, 10, 10, 3, 1, 1, 28, 1, 0.9, 1);
    expect(Array.from(ov.slice(0, 10))).toEqual(Array(10).fill(0.9).map((v) => Math.fround(v)));
    ov.fill(0);
    ovNode(ov, 10, 10, 3, 15, 15, 1, 3);
    expect([...ov].filter((v) => v > 0)).toHaveLength(9);
    const edge: FxEdge = { ax: 1, ay: 1, bx: 28, by: 28, t0: 0, dur: 0.2, lvl: 0 };
    drawOverlay(ov, 10, 10, 3, [edge], [], 0.5);
    expect(ov[9 * 10 + 9]).toBe(1); // the reached node is lit once the link arrives
    drawOverlay(ov, 10, 10, 3, [edge], [], 5);
    expect([...ov].every((v) => v === 0)).toBe(true);
  });
});

describe('fx/dither scene (with a minimal fake 2D context)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const fakeContext = () => ({
    fillStyle: '', font: '', textAlign: 'center', textBaseline: 'middle', imageSmoothingEnabled: true,
    measureText: () => ({ width: 300 }),
    fillText: () => undefined,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: vi.fn(),
    drawImage: vi.fn(),
  });

  it('a click grows links from the next frame on; leaving drops them and takes no new clicks', () => {
    const ctx = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const scene = new DitherScene();
    const colors = { ink: [0, 0, 0], accent: [1, 2, 3], pane: [9, 9, 9] } as const;
    scene.click(100, 100); // before the first frame: no nodes yet, ignored
    expect(scene.linkCount).toBe(0);
    const main = ctx as unknown as CanvasRenderingContext2D;
    scene.draw(main, 600, 400, 1, colors, 'sans-serif', false);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 600, 402);
    scene.click(300, 200);
    expect(scene.linkCount).toBeGreaterThan(0);
    scene.draw(main, 600, 400, 1.5, colors, 'sans-serif', true);
    expect(scene.linkCount).toBe(0);
    scene.click(300, 200);
    expect(scene.linkCount).toBe(0);
  });

  it('relayout rule: a new width, or a height change over RELAYOUT_DH px; else the layout stays', () => {
    expect(RELAYOUT_DH).toBe(64);
    expect(needsRelayout(null, 600, 400)).toBe(true);
    expect(needsRelayout({ w: 600, h: 400 }, 600, 400)).toBe(false);
    expect(needsRelayout({ w: 600, h: 400 }, 600, 440)).toBe(false); // the composer grew by lines
    expect(needsRelayout({ w: 600, h: 400 }, 600, 336)).toBe(false);
    expect(needsRelayout({ w: 600, h: 400 }, 600, 464)).toBe(false);
    expect(needsRelayout({ w: 600, h: 400 }, 600, 465)).toBe(true);
    expect(needsRelayout({ w: 600, h: 400 }, 600, 335)).toBe(true);
    expect(needsRelayout({ w: 600, h: 400 }, 601, 400)).toBe(true);
  });

  it('fitMask crops or extends the rows of a kept mask (new rows are ground), columns unchanged', () => {
    const base = emptyMask(3, 2, 3);
    base.m.set([1, 2, 3, 4, 5, 6]);
    const longer = fitMask(base, 3);
    expect(longer).toMatchObject({ cols: 3, rows: 3, cell: 3 });
    expect([...longer.m]).toEqual([1, 2, 3, 4, 5, 6, 0, 0, 0]);
    const shorter = fitMask(base, 1);
    expect([...shorter.m]).toEqual([1, 2, 3]);
    expect(fitMask(base, 2)).toBe(base);
  });

  it('a small height change keeps the word, the nodes and the live links; a big one or a new width lays out again', () => {
    const ctx = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const measure = vi.spyOn(ctx, 'measureText');
    const scene = new DitherScene();
    const colors = { ink: [0, 0, 0], accent: [1, 2, 3] } as const;
    const main = ctx as unknown as CanvasRenderingContext2D;
    scene.draw(main, 600, 400, 1, colors, 'sans-serif', false);
    const layouts = measure.mock.calls.length;
    scene.click(300, 200);
    const links = scene.linkCount;
    expect(links).toBeGreaterThan(0);
    expect(scene.busy).toBe(true);
    // The composer grows by two lines: the stage is 40 px shorter — and then taller again.
    scene.draw(main, 600, 360, 1.1, colors, 'sans-serif', false);
    expect(ctx.drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 0, 600, 360);
    scene.draw(main, 600, 440, 1.2, colors, 'sans-serif', false);
    expect(ctx.drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 0, 600, 441); // extended, not re-measured
    expect(measure.mock.calls.length).toBe(layouts);
    expect(scene.linkCount).toBe(links);
    // More than 64 px: a new layout (the word re-measured, the links of the old nodes gone).
    scene.draw(main, 600, 300, 1.3, colors, 'sans-serif', false);
    expect(measure.mock.calls.length).toBeGreaterThan(layouts);
    expect(scene.linkCount).toBe(0);
    scene.click(300, 150);
    expect(scene.linkCount).toBeGreaterThan(0);
    const before = measure.mock.calls.length;
    scene.draw(main, 610, 300, 1.4, colors, 'sans-serif', false);
    expect(measure.mock.calls.length).toBeGreaterThan(before);
    expect(scene.linkCount).toBe(0);
  });

  it('busy while links live or the field burns out; at rest otherwise; reset drops the links', () => {
    const ctx = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const scene = new DitherScene();
    const colors = { ink: [0, 0, 0], accent: [1, 2, 3] } as const;
    const main = ctx as unknown as CanvasRenderingContext2D;
    scene.draw(main, 600, 400, 1, colors, 'sans-serif', false);
    expect(scene.busy).toBe(false);
    scene.click(300, 200);
    expect(scene.busy).toBe(true);
    scene.draw(main, 600, 400, 10, colors, 'sans-serif', false); // long after the links faded
    expect(scene.busy).toBe(false);
    scene.click(300, 200);
    scene.reset();
    expect(scene.linkCount).toBe(0);
    expect(scene.busy).toBe(false);
    scene.draw(main, 600, 400, 10.1, colors, 'sans-serif', true);
    expect(scene.busy).toBe(true); // the burn-out runs at full rate
  });

  it('no 2D context: drawing is a no-op', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const scene = new DitherScene();
    const main = fakeContext();
    scene.draw(main as unknown as CanvasRenderingContext2D, 600, 400, 0, { ink: [0, 0, 0], accent: [0, 0, 0], pane: [0, 0, 0] }, 'x', false);
    expect(main.drawImage).not.toHaveBeenCalled();
  });
});

describe('fx/indicators connect', () => {
  it('draws the edges one by one over a cycle of edges + 2 beats', () => {
    const start = connectState(0);
    expect(start.progress.every((p) => p === 0)).toBe(true);
    expect(start.lit.every((l) => !l)).toBe(true);
    const mid = connectState(1.5 / 2.2); // cyc = 1.5: the first edge done, the second half-way
    expect(mid.progress[0]).toBe(1);
    expect(mid.progress[1]).toBeCloseTo(0.5, 9);
    expect(mid.current).toEqual([false, true, false, false, false, false]);
    expect(mid.lit).toEqual([true, true, false, false, false, false]);
    // A full cycle later it starts over.
    const period = (CONNECT_EDGES.length + 2) / 2.2;
    connectState(period + 0.1).progress.forEach((p, i) => expect(p).toBeCloseTo(connectState(0.1).progress[i]!, 9));
  });

  it('the reduced-motion still frame shows a graph mostly connected, the last edge being drawn', () => {
    const s = connectState(CONNECT_STILL_T);
    expect(s.progress.slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
    expect(s.current[5]).toBe(true);
    expect(s.lit.filter(Boolean)).toHaveLength(CONNECT_NODES.length - 1);
  });
});
