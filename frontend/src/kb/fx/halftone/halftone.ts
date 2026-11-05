/*
 * HalftoneReveal (stage 6, B11; DESIGN-SYSTEM.md decision 30): the empty-state art — three paper
 * sheets, the top one with text stripes (its title stripe in the FX accent) — drawn in halftone dots.
 * It draws itself ONCE from the centre outwards, then holds still: no loop.
 *
 * Reference: `.dev/ui-blocks/motion6/motion-v1.js` `halftonePts` + painter `halftone` — dots on a
 * 4-px staggered grid, radius ∝ tone (paper nearly white, edges and stripes dark); each dot grows
 * 0.3 s after a 0–0.6 s delay by its distance from the centre. Calm: the finished image fades in
 * 0.2 s (HalftoneArt); off: the still image. Mono ink with the FX accent on one stripe.
 */
import { clamp } from '../noise';
import { rgba, type FxColors } from '../colors';

/** Seconds: the outermost dot starts this late; each dot grows for GROW. */
export const HALFTONE_SPREAD_S = 0.6;
export const HALFTONE_GROW_S = 0.3;
/** The drawing is complete at this moment (the still frame is drawn at any t ≥ it). */
export const HALFTONE_DONE_S = HALFTONE_SPREAD_S + HALFTONE_GROW_S;
/** css px at scale 1: the grid step and the largest dot radius. */
const STEP = 4;
const R_MAX = 2.1;
const R_MIN = 0.35;

/** x, y (css px), tone 0..1, accent stripe, distance from the centre 0..1. */
export interface HalftoneDot { x: number; y: number; tone: number; accent: boolean; d: number }

interface Sheet { cx: number; cy: number; w: number; h: number; a: number; v: number; top?: boolean }
/** Text stripes of the top sheet: [y from its top, right inset, accent]. */
const STRIPES: ReadonlyArray<readonly [number, number, boolean]> = [
  [16, 30, true], [30, 14, false], [40, 22, false], [50, 12, false], [60, 26, false], [70, 18, false],
];

/** The art's dots for a canvas of w × h css px; `s` scales the drawing (1 = 200 × 116 in the demo). */
export function halftoneDots(w: number, h: number, s = 1): HalftoneDot[] {
  if (w <= 0 || h <= 0 || s <= 0) return [];
  const sp = STEP * s;
  const sheets: Sheet[] = [
    { cx: w / 2 - 26 * s, cy: h / 2 + 5 * s, w: 64 * s, h: 84 * s, a: -0.16, v: 0.1 },
    { cx: w / 2 + 26 * s, cy: h / 2 + 4 * s, w: 64 * s, h: 84 * s, a: 0.14, v: 0.12 },
    { cx: w / 2, cy: h / 2, w: 70 * s, h: 90 * s, a: 0, v: 0.12, top: true },
  ];
  const raw: Array<[number, number, number, boolean]> = [];
  for (let y = sp / 2, row = 0; y < h; y += sp, row += 1) {
    for (let x = sp / 2 + (row % 2) * (sp / 2); x < w; x += sp) {
      let tone = 0;
      let accent = false;
      for (const sh of sheets) {
        const dx = x - sh.cx;
        const dy = y - sh.cy;
        const u = dx * Math.cos(-sh.a) - dy * Math.sin(-sh.a);
        const v = dx * Math.sin(-sh.a) + dy * Math.cos(-sh.a);
        const ex = sh.w / 2 - Math.abs(u);
        const ey = sh.h / 2 - Math.abs(v);
        if (ex < 0 || ey < 0) continue;
        // A later (upper) sheet covers the ones below it.
        let t = Math.min(ex, ey) < 3 * s ? 0.85 : sh.v;
        accent = false;
        if (sh.top && t < 0.5) {
          const fromTop = v + sh.h / 2;
          const fromLeft = u + sh.w / 2;
          for (const [ry, inset, acc] of STRIPES) {
            if (Math.abs(fromTop - ry * s) < 2.2 * s && fromLeft > 9 * s && fromLeft < sh.w - inset * s) { t = acc ? 0.9 : 0.62; accent = acc; }
          }
        }
        tone = t;
      }
      if (tone > 0.05) raw.push([x, y, tone, accent]);
    }
  }
  const md = Math.hypot(w / 2, h / 2);
  return raw.map(([x, y, tone, accent]) => ({ x, y, tone, accent, d: Math.hypot(x - w / 2, y - h / 2) / md }));
}

/** How grown a dot at distance `d` is at time `t` (0..1, ease-out cubic). */
export function dotGrowth(t: number, d: number): number {
  const p = clamp((t - d * HALFTONE_SPREAD_S) / HALFTONE_GROW_S, 0, 1);
  return 1 - (1 - p) ** 3;
}

export const dotRadius = (tone: number, s = 1): number => Math.max(R_MIN, R_MAX * tone) * s;

/** Paint the art at time `t` (s): dots grown so far. Returns how many dots were drawn. */
export function drawHalftone(ctx: CanvasRenderingContext2D, dots: readonly HalftoneDot[], t: number, colors: FxColors, s = 1): number {
  let n = 0;
  const ink = rgba(colors.ink, 0.72);
  const accent = rgba(colors.accent, 0.9);
  for (const dot of dots) {
    const g = dotGrowth(t, dot.d);
    if (g <= 0) continue;
    ctx.fillStyle = dot.accent ? accent : ink;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dotRadius(dot.tone, s) * g, 0, Math.PI * 2);
    ctx.fill();
    n += 1;
  }
  return n;
}
