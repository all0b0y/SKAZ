/** N9 v4 prototype sglobe/sring geometry. Pure frames; no progress values or completion inference. */
import { clamp } from '../noise';
import type { StippleDot } from './stipple';

export interface WorkDot extends StippleDot { radius: number; alpha: number }
type Point3 = readonly [number, number, number];
const TAU = Math.PI * 2;
const sphere = (n: number): Point3[] => Array.from({ length: n }, (_, i) => {
  const y = 1 - (i + 0.5) / n * 2;
  const r = Math.sqrt(1 - y * y);
  const angle = i * 2.39996;
  return [Math.cos(angle) * r, y, Math.sin(angle) * r];
});
const SPHERES = { small: sphere(40), medium: sphere(70), large: sphere(160) };

/** A live gaussian band; explicit completion age fades to the prototype's fixed final frame. */
export function globeDots(w: number, h: number, t: number, completedAge?: number): WorkDot[] {
  const r = Math.min(w, h) / 2 - 1.2;
  if (!Number.isFinite(r) || r <= 0) return [];
  const points = r > 20 ? SPHERES.large : r > 9 ? SPHERES.medium : SPHERES.small;
  const completed = completedAge !== undefined;
  const rot = completed ? 0.6 : t * 0.7;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const band = completed ? -9 : (((t * 0.5) % 1.5) - 0.25) * 2 - 1;
  const out: WorkDot[] = [];
  for (const [x0, y0, z0] of points) {
    const x = x0 * cos + z0 * sin;
    const z = -x0 * sin + z0 * cos;
    if (z < -0.35) continue;
    const bandGain = Math.exp(-((x - band) ** 2) / 0.08) * (z > 0 ? 1 : 0.3);
    const k = completed ? clamp(1 - completedAge, 0, 1) : bandGain;
    out.push({ x: w / 2 + x * r + bandGain * 0.6, y: h / 2 - y0 * r, k,
      radius: (r > 20 ? 1.1 : 0.62) * (1 + 0.35 * k),
      alpha: clamp((z > 0 ? 0.35 + 0.45 * z : 0.12) + 0.5 * k, 0, 1) });
  }
  return out;
}

/** A circle of dots with one moving head; no CSS rotation or independent animation loop. */
export function ringDots(w: number, h: number, t: number): WorkDot[] {
  const r = Math.min(w, h) / 2 - 1.6;
  if (!Number.isFinite(r) || r <= 0) return [];
  const n = r > 8 ? 22 : 12;
  const head = (t * 1.3) % 1 * TAU;
  return Array.from({ length: n }, (_, i) => {
    const a = i / n * TAU;
    const d = ((head - a) % TAU + TAU) % TAU;
    const k = Math.exp(-(d * d) / 0.9);
    return { x: w / 2 + Math.sin(a) * r, y: h / 2 - Math.cos(a) * r, k,
      radius: (r > 8 ? 1.2 : 0.95) * (1 + 0.45 * k), alpha: 0.4 + 0.6 * k };
  });
}
