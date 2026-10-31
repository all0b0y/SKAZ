/*
 * «Connecting nodes» (FX-EFFECTS-SPEC Batch A §7, mock `THINK.connect`): a tiny graph that links
 * itself edge by edge while an answer is being written. 84×16 css px, drawn at dpr 2.
 */
import { clamp } from '../noise';
import { rgba, type FxColors, type Rgb } from '../colors';

export const CONNECT_W = 84;
export const CONNECT_H = 16;
export const CONNECT_NODES: readonly (readonly [number, number])[] = [[5, 9], [20, 4], [33, 12], [48, 5], [62, 11], [77, 6]];
export const CONNECT_EDGES: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [2, 3], [1, 3], [3, 4], [4, 5]];
/** The reduced-motion still frame: two edges done, the third being drawn. */
export const CONNECT_STILL_T = 2.4;

export interface ConnectState {
  /** Per edge: drawn fraction 0..1. */
  progress: number[];
  /** Per edge: being drawn now (0 < p < 1). */
  current: boolean[];
  /** Per node: reached by a finished edge. */
  lit: boolean[];
}

type Nodes = readonly (readonly [number, number])[];
type Edges = readonly (readonly [number, number])[];

/**
 * The pure state of a «Connecting nodes» graph at time t (s): the cycle runs over the edges + 2
 * beats of rest. Any small graph draws the same way (the thinking indicator, the chat-row mark).
 */
export function connectStateOf(t: number, nodes: Nodes, edges: Edges): ConnectState {
  const cyc = (t * 2.2) % (edges.length + 2);
  const progress = edges.map((_, i) => clamp(cyc - i, 0, 1));
  return {
    progress,
    current: progress.map((p) => p > 0 && p < 1),
    lit: nodes.map((_, n) => edges.some(([a, b], j) => (a === n || b === n) && cyc - j >= 1)),
  };
}

/** The thinking indicator's state at time t (s). */
export function connectState(t: number): ConnectState {
  return connectStateOf(t, CONNECT_NODES, CONNECT_EDGES);
}

/** Paint one frame of a graph in css px (the canvas transform carries the dpr). */
export function drawConnectGraph(ctx: CanvasRenderingContext2D, t: number, colors: FxColors, nodes: Nodes, edges: Edges): void {
  const s = connectStateOf(t, nodes, edges);
  const dot = (x: number, y: number, style: string) => {
    ctx.fillStyle = style;
    ctx.fillRect(Math.round(x / 2) * 2, Math.round(y / 2) * 2, 2, 2);
  };
  edges.forEach(([a, b], i) => {
    const p = s.progress[i]!;
    if (p <= 0) return;
    const [x0, y0] = nodes[a]!;
    const [x1, y1] = nodes[b]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const style = s.current[i] ? rgba(colors.accent, 0.95) : rgba(colors.ink, 0.6);
    for (let d = 0; d <= len * p; d += 2) dot(x0 + ((x1 - x0) * d) / len, y0 + ((y1 - y0) * d) / len, style);
  });
  nodes.forEach(([x, y], i) => {
    ctx.fillStyle = s.lit[i] ? rgba(colors.accent, 0.95) : rgba(colors.ink, 0.55);
    ctx.fillRect(x - 1.5, y - 1.5, 4, 4);
  });
}

/** Paint one frame of the thinking indicator in css px (the canvas transform carries the dpr). */
export function drawConnect(ctx: CanvasRenderingContext2D, t: number, colors: FxColors): void {
  drawConnectGraph(ctx, t, colors, CONNECT_NODES, CONNECT_EDGES);
}

/*
 * The chat-row mark of a chat at work (DESIGN-SYSTEM.md decision 26): the same drawing with three
 * nodes, 28×14 css px at dpr 2, after the title. When the answer is ready the nodes pull together into
 * the point where the «new» dot appears.
 */
export const MARK_W = 28;
export const MARK_H = 14;
export const MARK_NODES: Nodes = [[3, 9], [13, 4], [23, 9]];
export const MARK_EDGES: Edges = [[0, 1], [1, 2]];
/** Where the nodes meet when the answer is ready (the «new» dot's centre in the mark's box). */
export const MARK_END = [24, 7] as const;
/** The pull takes this long (s, ease-out cubic); the nodes fade between FADE_FROM and FADE_TO. */
export const MARK_PULL_S = 0.5;
export const MARK_FADE_FROM_S = 0.45;
export const MARK_FADE_TO_S = 0.6;

export interface MarkResolve {
  /** The nodes' centres now. */
  nodes: Array<[number, number]>;
  /** 0 = ink, 1 = accent. */
  mix: number;
  /** Node opacity. */
  alpha: number;
}

/** The «answer ready» frame at td seconds after the answer arrived (pure). */
export function markResolve(td: number): MarkResolve {
  const p = 1 - Math.pow(1 - clamp(td / MARK_PULL_S, 0, 1), 3);
  const fade = clamp(1 - (td - MARK_FADE_FROM_S) / (MARK_FADE_TO_S - MARK_FADE_FROM_S), 0, 1);
  return {
    nodes: MARK_NODES.map(([x, y]) => [x + (MARK_END[0] - x) * p, y + (MARK_END[1] - y) * p]),
    mix: p,
    alpha: 0.9 * fade,
  };
}

/** Paint the «answer ready» frame. */
export function drawMarkResolve(ctx: CanvasRenderingContext2D, td: number, colors: FxColors): void {
  const r = markResolve(td);
  if (r.alpha <= 0) return;
  const [ir, ig, ib] = colors.ink;
  const [ar, ag, ab] = colors.accent;
  const c: Rgb = [ir + (ar - ir) * r.mix, ig + (ag - ig) * r.mix, ib + (ab - ib) * r.mix];
  ctx.fillStyle = rgba(c, r.alpha);
  for (const [x, y] of r.nodes) ctx.fillRect(Math.round(x - 2), Math.round(y - 2), 4, 4);
}
