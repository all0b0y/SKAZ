import { describe, expect, it } from 'vitest';
import type { KbGraph } from '../../api/kb/types.gen';
import { bounds, createSim, fit, pick, settle, showsLabel, step, toScreen, zoomAt, ZOOM_MAX } from './layout';

function graph(n: number, edges: Array<[number, number]>, hub: number[] = []): KbGraph {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, kind: 'concept' as const, title: `Node ${i}`, folder_ids: [i % 2 ? 'a' : 'b'], degree: 0, hub: hub.includes(i) })),
    edges: edges.map(([a, b]) => ({ source: `n${a}`, target: `n${b}`, kind: 'link' as const, cross_folder: a % 2 !== b % 2, page_id: null, block_id: null })),
  };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('Graph force layout (own, no library)', () => {
  it('starts the same way for the same graph and ignores edges to unknown nodes', () => {
    const g = graph(6, [[0, 1], [1, 2], [0, 9]]);
    const a = createSim(g);
    const b = createSim(g);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    expect(a.edges).toHaveLength(2);
    expect(a.adj.get('n0')).toEqual(new Set(['n1']));
  });

  it('cools down to rest: linked nodes end up closer than unlinked ones, nothing overlaps', () => {
    const sim = createSim(graph(8, [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2]]));
    settle(sim);
    expect(sim.alpha).toBe(0);
    expect(step(sim)).toBe(false);
    const [n0, n1, n7] = [sim.byId.get('n0')!, sim.byId.get('n1')!, sim.byId.get('n7')!];
    expect(dist(n0, n1)).toBeLessThan(dist(n0, n7));
    for (const p of sim.nodes) for (const q of sim.nodes) if (p !== q) expect(dist(p, q)).toBeGreaterThan(4);
  });

  it('fits the whole graph into the canvas and zooms around the pointer', () => {
    const sim = createSim(graph(12, [[0, 1], [1, 2], [2, 3]]));
    settle(sim);
    const view = fit(sim, 400, 300);
    const b = bounds(sim);
    for (const corner of [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY }]) {
      const p = toScreen(view, corner);
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(400);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(300);
    }
    const before = { x: (120 - view.x) / view.k, y: (80 - view.y) / view.k };
    const zoomed = zoomAt(view, 120, 80, 2);
    expect(toScreen(zoomed, before).x).toBeCloseTo(120);
    expect(toScreen(zoomed, before).y).toBeCloseTo(80);
    expect(zoomAt(view, 0, 0, 1000).k).toBe(ZOOM_MAX);
  });

  it('picks the node under the pointer; labels only for hubs, the selected node and hover neighbours', () => {
    const sim = createSim(graph(5, [[0, 1], [1, 2]], [4]));
    settle(sim);
    const view = fit(sim, 400, 300);
    const n2 = sim.byId.get('n2')!;
    const at = toScreen(view, n2);
    expect(pick(sim, view, at.x + 1, at.y)?.id).toBe('n2');
    expect(pick(sim, view, -500, -500)).toBeNull();
    const calm = { ...view, k: 1 };
    expect(showsLabel(sim.byId.get('n4')!, sim, calm, null, null)).toBe(true); // hub
    expect(showsLabel(sim.byId.get('n0')!, sim, calm, null, null)).toBe(false);
    expect(showsLabel(sim.byId.get('n0')!, sim, calm, 'n1', null)).toBe(true); // neighbour of hover
    expect(showsLabel(sim.byId.get('n3')!, sim, calm, null, 'n3')).toBe(true); // selected
  });
});
