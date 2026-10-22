/*
 * «Stippling» maths (FX-EFFECTS-SPEC batch B2; mock elements-v3 `MINI.stipple` / `STRIP.stipple`).
 * Pure: points, lens displacement, the moving band. Painting is in draw.ts; nothing here touches the DOM.
 */
import { clamp, mulberry32 } from '../noise';

export type Pt = readonly [number, number];

/** A dot as drawn: its displaced position and how far it was pushed (k: 0 = at rest, 1 = fully lit). */
export interface StippleDot {
  x: number;
  y: number;
  k: number;
}

/** Dots below this displacement are not drawn at all — the field has no ground (quiet at rest). */
export const MIN_K = 0.03;

/**
 * The resting field: a jittered 4.5-px grid, 55 % of the cells kept. Seeded by the box size, so a
 * given size always gives the same dots (mock: `mulberry(w + h)`).
 */
export function stipplePoints(w: number, h: number): Pt[] {
  const rnd = mulberry32(Math.round(w + h));
  const out: Pt[] = [];
  for (let y = 2; y < h; y += 4.5) {
    for (let x = 2; x < w; x += 4.5) {
      if (rnd() < 0.55) out.push([x + (rnd() - 0.5) * 3, y + (rnd() - 0.5) * 3]);
    }
  }
  return out;
}

/** A lens that pushes dots away from (x, y): within `radius`, by up to `shift` px × amount × kScale. */
export interface Lens {
  x: number;
  y: number;
  radius: number;
  /** 0..1 strength (the hover amount, or the fade of the toast arrival). */
  amount: number;
  /** Largest displacement in px at full strength. */
  shift: number;
  /** Scales k (the toast variant is subtler: ×0.6). */
  kScale: number;
}

/** Only the displaced dots: a dot outside the lens (or barely moved) is skipped, nothing is "ground". */
export function lensDots(points: ReadonlyArray<Pt>, lens: Lens): StippleDot[] {
  const out: StippleDot[] = [];
  if (lens.amount <= 0 || lens.radius <= 0) return out;
  for (const [x0, y0] of points) {
    const dx = x0 - lens.x;
    const dy = y0 - lens.y;
    const d = Math.hypot(dx, dy) || 1;
    const k = clamp(1 - d / lens.radius, 0, 1) * lens.amount * lens.kScale;
    if (k < MIN_K) continue;
    out.push({ x: x0 + (dx / d) * k * lens.shift, y: y0 + (dy / d) * k * lens.shift, k });
  }
  return out;
}

/* ---- Citation chip: hover lens ---- */

export const CHIP_RADIUS = 26;
export const CHIP_SHIFT = 7;

export function chipLens(cx: number, cy: number, hover: number): Lens {
  return { x: cx, y: cy, radius: CHIP_RADIUS, amount: clamp(hover, 0, 1), shift: CHIP_SHIFT, kScale: 1 };
}

/** The hover amount follows its target with a ~0.07 s time constant (mock: ×0.22 per 60-Hz frame). */
export function stepHover(current: number, target: number, dt: number): number {
  const next = current + (target - current) * (1 - Math.exp(-dt * 15));
  return Math.abs(target - next) < 0.005 ? target : next;
}

/* ---- Toast: the subtle arrival ---- */

export const TOAST_DURATION_S = 1;
export const TOAST_SHIFT = 3;
const TOAST_GROW_S = 0.9;

/** `age` = seconds since the toast appeared. null once the ~1 s shimmer is over. */
export function toastLens(x: number, y: number, age: number): Lens | null {
  if (age < 0 || age >= TOAST_DURATION_S) return null;
  return {
    x,
    y,
    radius: 8 + Math.min(1, age / TOAST_GROW_S) * 18,
    amount: 1 - age / TOAST_DURATION_S,
    shift: TOAST_SHIFT,
    kScale: 0.6,
  };
}

/* ---- Progress strip: an indeterminate moving band ---- */

/** The strip is this tall (css px) in its own row. */
export const STRIP_HEIGHT = 6;

/** Dots of the strip: ~one per 2.2 px of width, scattered over the height (mock: `mulberry(5)`). */
export function stripPoints(w: number, h: number): Pt[] {
  const rnd = mulberry32(5);
  const out: Pt[] = [];
  for (let i = 0; i < w / 2.2; i++) out.push([rnd() * w, 1 + rnd() * (h - 2)]);
  return out;
}

/** Centre of the band at time t: sweeps from -0.2 w to 1.2 w every ~3.1 s, then starts again. */
export function stripBandX(t: number, w: number): number {
  const phase = ((t * 0.45) % 1.4 + 1.4) % 1.4;
  return (phase - 0.2) * w;
}

/** How much a dot at x belongs to the band (gaussian, 0..1). */
export function stripGain(x: number, bandX: number, w: number): number {
  if (w <= 0) return 0;
  return Math.exp(-((x - bandX) ** 2) / (w * w * 0.015));
}

/** Dot radius and alpha for a gain v: quiet ink at rest, larger and brighter inside the band. */
export function stripDotStyle(v: number): { radius: number; alpha: number } {
  return { radius: 0.8 + v * 0.4, alpha: 0.15 + 0.8 * v };
}
