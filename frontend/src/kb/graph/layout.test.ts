import { describe, expect, it } from 'vitest';
import type { KbGraph } from '../../api/kb/types.gen';
import { bounds, createSim, fit, pick, placeLabels, settle, showsLabel, step, toScreen, zoomAt, ZOOM_MAX } from './layout';

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

  it('labels never sit on each other; the selected one always shows; zooming in shows more (QA C5)', () => {
    // A dense library: 90 nodes, a third of them hubs, many links (like the QA profile: 96 nodes, 32 hubs).
    const n = 90;
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < n; i += 1) for (let j = 1; j <= 5; j += 1) edges.push([i, (i * 7 + j * 11) % n]);
    const sim = createSim(graph(n, edges.filter(([a, b]) => a !== b), Array.from({ length: 30 }, (_, i) => i * 3)));
    settle(sim);
    const measure = (text: string) => text.length * 6.6;
    const overlaps = (labels: ReturnType<typeof placeLabels>) => {
      const box = (l: (typeof labels)[number]) => ({ l: l.x - measure(l.text) / 2, r: l.x + measure(l.text) / 2, t: l.y, b: l.y + 15 });
      let count = 0;
      labels.forEach((a, i) => labels.slice(i + 1).forEach((b) => {
        const p = box(a); const q = box(b);
        if (p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b) count += 1;
      }));
      return count;
    };
    const view = fit(sim, 556, 600, 36, 26);
    const atRest = placeLabels(sim, view, null, 'n1', measure);
    expect(overlaps(atRest)).toBe(0);
    expect(atRest[0]?.id).toBe('n1'); // selected first, even though it isn't a hub
    expect(atRest.length).toBeGreaterThan(3);
    const wanted = sim.nodes.filter((x) => showsLabel(x, sim, view, null, 'n1')).length;
    expect(atRest.length).toBeLessThan(wanted); // the ones that would pile up are left out
    const closer = placeLabels(sim, zoomAt(view, 278, 300, 3), null, 'n1', measure)
      .filter((l) => l.x >= 0 && l.x <= 556 && l.y >= 0 && l.y <= 600);
    expect(overlaps(closer)).toBe(0);
    expect(closer.length).toBeGreaterThan(atRest.filter((l) => l.x >= 0 && l.x <= 556).length / 2);
  });

  it('fit leaves the hint strip under the graph free', () => {
    const sim = createSim(graph(12, [[0, 1], [1, 2], [2, 3]]));
    settle(sim);
    const view = fit(sim, 400, 300, 36, 26);
    expect(toScreen(view, { x: 0, y: bounds(sim).maxY }).y).toBeLessThanOrEqual(300 - 26);
  });
});
