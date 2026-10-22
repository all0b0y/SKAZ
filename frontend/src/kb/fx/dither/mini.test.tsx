import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EmptyState } from '../../ui';
import { MiniDither } from './MiniDither';
import { connectBurst } from './graph';
import { MINI_ALPHA, MINI_BURST, MINI_CELL, MiniScene, miniGroundOn, miniNodes, renderMiniBase } from './mini';
import type { FxColors } from '../colors';

const colors: FxColors = { ink: [44, 46, 49], accent: [90, 116, 32], pane: [255, 255, 255] };

describe('fx/dither/mini maths', () => {
  it('nodes: a jittered step-17 grid, deterministic per size, all inside', () => {
    const a = miniNodes(260, 70);
    expect(miniNodes(260, 70)).toEqual(a);
    expect(a.length).toBe(15 * 4); // 15 columns × 4 rows
    expect(a.every((n) => n.x > -7 && n.x < 267 && n.y > -7 && n.y < 77)).toBe(true);
    expect(miniNodes(260, 40)).not.toEqual(a.slice(0, 15 * 2)); // another size, another field
  });

  it('burst: BFS two levels, 3 then 2 each, all within 70 px, no node used twice', () => {
    const nodes = miniNodes(260, 70);
    const edges = connectBurst(nodes, 130, 35, 0, MINI_BURST);
    const l0 = edges.filter((e) => e.lvl === 0);
    const l1 = edges.filter((e) => e.lvl === 1);
    expect(l0).toHaveLength(3);
    expect(l1.length).toBeGreaterThan(0);
    expect(l1.length).toBeLessThanOrEqual(6);
    expect(edges.every((e) => e.lvl < 2 && Math.hypot(e.bx - e.ax, e.by - e.ay) < 70)).toBe(true);
    expect(new Set(edges.map((e) => `${e.bx},${e.by}`)).size).toBe(edges.length);
    expect(l1.every((e) => e.t0 > l0[0]!.t0)).toBe(true);
  });

  it('base layer is quiet: nodes ink α ≤ 0.2 (2×2 px), ground ≤ 0.07', () => {
    expect(MINI_ALPHA.node).toBeLessThanOrEqual(0.2);
    expect(MINI_ALPHA.ground).toBeLessThanOrEqual(0.07);
    const w = 120;
    const h = 40;
    const cols = w / MINI_CELL;
    const rows = h / MINI_CELL;
    const px = new Uint8ClampedArray(cols * rows * 4);
    const nodes = miniNodes(w, h);
    renderMiniBase(px, cols, rows, nodes, colors.ink);
    const alphas = new Set<number>();
    for (let i = 0; i < cols * rows; i++) alphas.add(px[i * 4 + 3]!);
    expect([...alphas].every((a) => a === 0 || a === Math.round(0.07 * 255) || a === Math.round(0.2 * 255))).toBe(true);
    let ground = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (miniGroundOn(c, r)) ground++;
    expect(ground).toBeGreaterThan(0);
    expect(ground).toBeLessThan(cols * rows * 0.4); // sparse, not a grey wash
    for (const n of nodes) expect(px[(Math.floor(n.y / 2) * cols + Math.floor(n.x / 2)) * 4 + 3]).toBe(Math.round(0.2 * 255));
  });
});

/** A recording 2D context: enough surface for FxCanvas and MiniScene. */
function fakeCtx() {
  const accentRects: number[] = [];
  const ctx: Record<string, unknown> = {
    setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), putImageData: vi.fn(),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    fillRect: vi.fn(() => { accentRects.push(1); }),
    fillStyle: '', globalAlpha: 1, imageSmoothingEnabled: true,
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills: accentRects };
}

describe('MiniScene', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draws the resting frame without any link; a click grows links that die out', () => {
    const { ctx, fills } = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    const scene = new MiniScene();
    expect(scene.draw(ctx, 200, 70, 0, colors)).toBe(false);
    expect(fills).toHaveLength(0);
    scene.click(100, 35);
    expect(scene.draw(ctx, 200, 70, 0, colors)).toBe(true);
    expect(scene.linkCount).toBeGreaterThan(0);
    expect(scene.draw(ctx, 200, 70, 1.0, colors)).toBe(true);
    expect(fills.length).toBeGreaterThan(0);
    expect(scene.draw(ctx, 200, 70, 4, colors)).toBe(false); // faded: a clean frame, loop may stop
    expect(scene.linkCount).toBe(0);
  });

  it('a click before the first frame is ignored', () => {
    const { ctx } = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    const scene = new MiniScene();
    scene.click(10, 10);
    expect(scene.draw(ctx, 200, 70, 0, colors)).toBe(false);
  });
});

describe('MiniDither / EmptyState', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('default EmptyState renders as before: no field', () => {
    const { container } = render(<EmptyState icon="chats" title="No chats yet">Later.</EmptyState>);
    expect(container.querySelector('.kb-empty__field')).toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.firstElementChild!.children).toHaveLength(3); // icon, title, text
  });

  it('field: an aria-hidden canvas above the icon and the title, sized by variant', () => {
    const { container } = render(<><EmptyState icon="chats" title="A" field /><EmptyState icon="chats" title="B" compact field /></>);
    const [a, b] = Array.from(container.querySelectorAll('.kb-empty'));
    expect(a!.firstElementChild).toHaveClass('kb-empty__field');
    expect(a!.firstElementChild).not.toHaveClass('kb-empty__field--compact');
    expect(b!.firstElementChild).toHaveClass('kb-empty__field--compact');
    expect(a!.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('A')).toBeVisible();
    expect(a!.firstElementChild!.getAttribute('data-interactive')).toBe('true');
  });

  it('reduced motion: still frame, no pointer reaction', () => {
    const { container } = render(<MiniDither reduced />);
    const field = container.firstElementChild!;
    expect(field).toHaveAttribute('data-still', 'true');
    expect(field).not.toHaveAttribute('data-interactive');
    fireEvent.pointerDown(field, { clientX: 10, clientY: 10 }); // nothing to react: no throw, no loop
    expect(container.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true');
  });

  it('a click starts the loop with accent pixels and the loop stops by itself', () => {
    const { ctx, fills } = fakeCtx();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 70, left: 0, top: 0, right: 200, bottom: 70, x: 0, y: 0, toJSON: () => ({}) });
    let now = 0;
    const queue = new Map<number, (t: number) => void>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { queue.set(++id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (i: number) => { queue.delete(i); });
    const { container } = render(<MiniDither reduced={false} />);
    expect(queue.size).toBe(0); // at rest: no animation loop
    expect(ctx.drawImage).toHaveBeenCalled(); // but the resting frame is drawn
    fireEvent.pointerDown(container.firstElementChild!, { clientX: 100, clientY: 35 });
    const run = (ms: number) => {
      const end = now + ms;
      while (now < end) {
        now += 33;
        const batch = [...queue.values()];
        queue.clear();
        act(() => batch.forEach((f) => f(now)));
      }
    };
    run(600);
    expect(fills.length).toBeGreaterThan(0);
    run(4500);
    expect(queue.size).toBe(0); // the loop ended on its own
    getContext.mockRestore();
    vi.restoreAllMocks();
  });
});
