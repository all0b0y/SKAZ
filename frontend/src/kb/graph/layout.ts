// Force layout of the wiki graph: a small, dependency-free simulation (decision v4/v5).
// Pure functions over plain objects so it is unit-testable and deterministic (seeded start).

import type { KbGraph, KbGraphEdge, KbGraphNode } from '../api/b2-u3';

export interface SimNode {
  id: string;
  node: KbGraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius in graph units, grows with the number of links. */
  r: number;
  /** Pinned while the user drags it. */
  fixed: boolean;
}

export interface Sim {
  nodes: SimNode[];
  edges: Array<{ a: SimNode; b: SimNode; edge: KbGraphEdge }>;
  byId: Map<string, SimNode>;
  adj: Map<string, Set<string>>;
  alpha: number;
}

export interface View {
  x: number;
  y: number;
  k: number;
}

const REPULSE = 900;
const SPRING_LEN = 56;
const SPRING_K = 0.045;
const CENTER_K = 0.014;
const DAMP = 0.82;
export const ALPHA_MIN = 0.002;
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 4;

/** Seeded start positions: the same graph always opens the same way. */
export function createSim(graph: KbGraph, seed = 7): Sim {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const spread = 40 + Math.sqrt(graph.nodes.length) * 28;
  const nodes: SimNode[] = graph.nodes.map((node) => ({
    id: node.id, node, x: (rnd() - 0.5) * spread, y: (rnd() - 0.5) * spread * 0.75, vx: 0, vy: 0, r: 0, fixed: false,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  const edges: Sim['edges'] = [];
  for (const edge of graph.edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b || a === b) continue;
    edges.push({ a, b, edge });
    adj.get(a.id)!.add(b.id);
    adj.get(b.id)!.add(a.id);
  }
  for (const n of nodes) n.r = 3 + Math.sqrt(Math.max(adj.get(n.id)!.size, n.node.degree)) * 1.9 + (n.node.hub ? 1.5 : 0);
  return { nodes, edges, byId, adj, alpha: 1 };
}

/** One step of the simulation at strength `alpha`. */
export function tick(sim: Sim, alpha = sim.alpha): void {
  const N = sim.nodes;
  for (let i = 0; i < N.length; i += 1) {
    const p = N[i]!;
    for (let j = i + 1; j < N.length; j += 1) {
      const q = N[j]!;
      let dx = q.x - p.x;
      let dy = q.y - p.y;
      const d2 = dx * dx + dy * dy + 0.01;
      const d = Math.sqrt(d2);
      const f = (REPULSE / d2) * alpha;
      dx /= d; dy /= d;
      p.vx -= dx * f; p.vy -= dy * f;
      q.vx += dx * f; q.vy += dy * f;
    }
  }
  for (const { a, b } of sim.edges) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - SPRING_LEN) * SPRING_K * alpha;
    a.vx += (dx / d) * f; a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
  }
  for (const n of N) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx -= n.x * CENTER_K * alpha;
    n.vy -= n.y * CENTER_K * alpha;
    n.vx *= DAMP; n.vy *= DAMP;
    n.x += n.vx; n.y += n.vy;
  }
}

/** Advance the cooling simulation by one frame; false when it has come to rest. */
export function step(sim: Sim): boolean {
  if (sim.alpha < ALPHA_MIN) return false;
  tick(sim, sim.alpha);
  sim.alpha *= 0.985;
  return sim.alpha >= ALPHA_MIN;
}

/** Run the whole cooling at once (reduced motion: the final layout, no animation). */
export function settle(sim: Sim, maxSteps = 500): void {
  for (let i = 0; i < maxSteps && step(sim); i += 1) { /* cooling */ }
  sim.alpha = 0;
}

export function reheat(sim: Sim, to = 0.3): void {
  sim.alpha = Math.max(sim.alpha, to);
}

export function bounds(sim: Sim): { minX: number; maxX: number; minY: number; maxY: number } {
  if (sim.nodes.length === 0) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const n of sim.nodes) {
    minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
    minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
  }
  return { minX, maxX, minY, maxY };
}

/** View that shows the whole graph with a margin. */
export function fit(sim: Sim, width: number, height: number, margin = 36): View {
  const b = bounds(sim);
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const k = clampZoom(Math.min((width - margin * 2) / w, (height - margin * 2) / h, 2.2));
  return { k, x: width / 2 - ((b.minX + b.maxX) / 2) * k, y: height / 2 - ((b.minY + b.maxY) / 2) * k };
}

export function clampZoom(k: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
}

/** Zoom by `factor` keeping the graph point under (mx, my) in place. */
export function zoomAt(view: View, mx: number, my: number, factor: number): View {
  const k = clampZoom(view.k * factor);
  return { k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k };
}

export function toScreen(view: View, n: { x: number; y: number }): { x: number; y: number } {
  return { x: view.x + n.x * view.k, y: view.y + n.y * view.k };
}

export function toGraph(view: View, mx: number, my: number): { x: number; y: number } {
  return { x: (mx - view.x) / view.k, y: (my - view.y) / view.k };
}

/** The node under the pointer, with a forgiving hit radius. */
export function pick(sim: Sim, view: View, mx: number, my: number): SimNode | null {
  let best: SimNode | null = null;
  let bestD = Infinity;
  for (const n of sim.nodes) {
    const p = toScreen(view, n);
    const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
    if (d < bestD) { bestD = d; best = n; }
  }
  if (!best) return null;
  const hit = Math.max(10, best.r * view.k + 4);
  return bestD <= hit * hit ? best : null;
}

/** Labels only where they help: hubs, the selected node, the hovered one and its neighbours. */
export function showsLabel(n: SimNode, sim: Sim, view: View, focus: string | null, selected: string | null): boolean {
  if (n.id === focus || n.id === selected || n.node.hub) return true;
  if (focus && sim.adj.get(focus)?.has(n.id)) return true;
  return view.k > 1.8;
}
