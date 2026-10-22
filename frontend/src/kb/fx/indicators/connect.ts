/*
 * «Connecting nodes» (FX-EFFECTS-SPEC Batch A §7, mock `THINK.connect`): a tiny graph that links
 * itself edge by edge while an answer is being written. 84×16 css px, drawn at dpr 2.
 */
import { clamp } from '../noise';
import { rgba, type FxColors } from '../colors';

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

/** The pure state of the indicator at time t (s): the cycle runs over edges + 2 beats of rest. */
export function connectState(t: number): ConnectState {
  const cyc = (t * 2.2) % (CONNECT_EDGES.length + 2);
  const progress = CONNECT_EDGES.map((_, i) => clamp(cyc - i, 0, 1));
  return {
    progress,
    current: progress.map((p) => p > 0 && p < 1),
    lit: CONNECT_NODES.map((_, n) => CONNECT_EDGES.some(([a, b], j) => (a === n || b === n) && cyc - j >= 1)),
  };
}

/** Paint one frame in css px (the canvas transform carries the dpr). */
export function drawConnect(ctx: CanvasRenderingContext2D, t: number, colors: FxColors): void {
  const s = connectState(t);
  const dot = (x: number, y: number, style: string) => {
    ctx.fillStyle = style;
    ctx.fillRect(Math.round(x / 2) * 2, Math.round(y / 2) * 2, 2, 2);
  };
  CONNECT_EDGES.forEach(([a, b], i) => {
    const p = s.progress[i]!;
    if (p <= 0) return;
    const [x0, y0] = CONNECT_NODES[a]!;
    const [x1, y1] = CONNECT_NODES[b]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const style = s.current[i] ? rgba(colors.accent, 0.95) : rgba(colors.ink, 0.6);
    for (let d = 0; d <= len * p; d += 2) dot(x0 + ((x1 - x0) * d) / len, y0 + ((y1 - y0) * d) / len, style);
  });
  CONNECT_NODES.forEach(([x, y], i) => {
    ctx.fillStyle = s.lit[i] ? rgba(colors.accent, 0.95) : rgba(colors.ink, 0.55);
    ctx.fillRect(x - 1.5, y - 1.5, 4, 4);
  });
}
