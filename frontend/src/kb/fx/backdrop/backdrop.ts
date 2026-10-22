/*
 * The chat backdrop «breathes with the agent» (CHAT-BACKDROP-SPEC; mock chat-backdrop-v2, variant
 * `mine`, ink `faint`, accent dots `some`, «Keep text clear» on). Three soft 1-bit dither patches
 * behind a chat that has messages: almost still at rest, flowing while the agent writes an answer.
 * Everything here is pure (no DOM): the scene and the component only feed it sizes, time and colours.
 */
import { BAYER4, fbm, hash2 } from '../noise';
import type { Rgb } from '../colors';
import { FX_REST_MS } from '../loop';

/** Css px per cell (the 1-bit look of the other FX). */
export const BACKDROP_CELL = 3;
/** Ink alpha of a lit dot (`faint`). */
export const BACKDROP_INK_ALPHA = 0.06;
/** The share of the dots that is the accent, chosen per 2×2 clump (`some`). */
export const BACKDROP_ACCENT_SHARE = 0.3;
/** Accent dots are this much stronger than ink dots. */
export const BACKDROP_ACCENT_GAIN = 2.2;
/** Extra alpha a dot takes at full energy (the agent working). */
export const BACKDROP_WORK_ALPHA = 0.06;
/** Noise frequency per css px. */
export const BACKDROP_NOISE_SCALE = 0.011;

/**
 * The message column as chat.css lays it out: `.kb-chat__messages` has 22 px side padding and the
 * answer's parts are at most 760 px wide (`.kb-msg--assistant > *`), left-aligned — not centred.
 */
export const CHAT_COLUMN = { padX: 22, max: 760 } as const;
/** column(): 0 from 24 px inside the column's edge, 1 by 56 px outside it (the mock's smoothstep). */
export const COLUMN_EDGE = { inside: 24, outside: 56 } as const;
/** Inside the column the level keeps a quarter («Keep text clear»). */
export const COLUMN_FLOOR = 0.25;

export interface BackdropBlob {
  /** Centre as fractions of the area. */
  x: number;
  y: number;
  /** Radius, css px. */
  r: number;
  /** Drift amplitude as fractions of the area. */
  ax: number;
  ay: number;
  /** Loop period (s) and phase (rad). */
  p: number;
  ph: number;
}

/** The mock's BLOBS: top-left, right, and the one under the composer that grows while working. */
export const BACKDROP_BLOBS: readonly BackdropBlob[] = Object.freeze([
  { x: 0.16, y: 0.30, r: 210, ax: 0.07, ay: 0.10, p: 97, ph: 0.0 },
  { x: 0.86, y: 0.62, r: 250, ax: 0.06, ay: 0.08, p: 83, ph: 2.1 },
  { x: 0.55, y: 0.95, r: 190, ax: 0.10, ay: 0.04, p: 109, ph: 4.0 },
]);
/** The bottom patch grows ×(1 + 0.45·energy). */
export const GROWING_BLOB = 2;
export const BLOB_GROWTH = 0.45;

/** Energy eases towards 1 at this rate (1/s) when work starts… */
export const ENERGY_UP = 2.5;
/** …and back to 0 at this one when it ends. */
export const ENERGY_DOWN = 0.9;
/** Closer than this to the target, energy snaps onto it (so rest is an exact 0). */
export const ENERGY_SNAP = 0.005;
/** Above this the backdrop counts as moving (~15 fps). */
export const ENERGY_EPS = 0.01;
/** ~15 fps while the agent works. */
export const WORKING_FRAME_MS = 66;
/** At rest the loop stops once nothing changed for this long (s): a still frame, no loop. */
export const SETTLE_S = 2;

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface ColumnBand { left: number; right: number }

/** The message column of an area `w` css px wide. */
export function columnBand(w: number): ColumnBand {
  const left = Math.min(CHAT_COLUMN.padX, w / 2);
  return { left, right: left + Math.max(0, Math.min(CHAT_COLUMN.max, w - 2 * CHAT_COLUMN.padX)) };
}

/** 0 inside the message column, rising to 1 by 56 px outside it (mock `column()`). */
export function columnFactor(x: number, band: ColumnBand): number {
  const { left, right } = band;
  const d = x < left ? left - x : x > right ? x - right : -Math.min(x - left, right - x);
  return smoothstep(-COLUMN_EDGE.inside, COLUMN_EDGE.outside, d);
}

/** «Keep text clear»: the level is multiplied by this (a quarter in the column, whole outside). */
export function clearFactor(x: number, band: ColumnBand): number {
  return COLUMN_FLOOR + (1 - COLUMN_FLOOR) * columnFactor(x, band);
}

/** Falloff of a patch at normalised distance d (0 = centre, 1 = edge): (1 − d)^1.4, 0 outside. */
export function patchFalloff(d: number): number {
  return d < 1 ? Math.pow(1 - Math.max(0, d), 1.4) : 0;
}

/** Level inside a patch: falloff × (0.55 + 0.75·fbm). */
export function patchLevel(falloff: number, n: number): number {
  return falloff * (0.55 + 0.75 * n);
}

/** Centre of a patch (css px) at drift time `driftT` (mock `blobAt`). */
export function blobAt(b: BackdropBlob, w: number, h: number, driftT: number): [number, number] {
  const k = (2 * Math.PI * driftT) / b.p + b.ph;
  return [w * (b.x + b.ax * Math.sin(k)), h * (b.y + b.ay * Math.cos(k * 0.8))];
}

/** Radius of patch `i` at `energy`: the bottom one grows while the agent works. */
export function blobRadius(i: number, energy: number, blobs: readonly BackdropBlob[] = BACKDROP_BLOBS): number {
  return blobs[i]!.r * (i === GROWING_BLOB ? 1 + BLOB_GROWTH * energy : 1);
}

/** How fast the patches drift (drift time per second): ×0.15 at rest, ×1.75 at full energy. */
export const driftRate = (energy: number): number => 0.15 + 1.6 * energy;
/** How fast the noise flows (noise units per second): 0.004 at rest, 0.054 at full energy. */
export const flowRate = (energy: number): number => 0.004 + 0.05 * energy;

/** One easing step of the energy towards `target` over `dt` seconds (mock loop), snapped near it. */
export function easeEnergy(energy: number, target: number, dt: number): number {
  if (dt <= 0) return energy;
  const rate = target > energy ? ENERGY_UP : ENERGY_DOWN;
  const next = energy + (target - energy) * Math.min(1, dt * rate);
  return Math.abs(target - next) < ENERGY_SNAP ? target : next;
}

/** The accent dots: a stable hash per 2×2 clump of cells picks `share` of them. */
export function accentCell(c: number, r: number, share: number = BACKDROP_ACCENT_SHARE): boolean {
  return hash2((c >> 1) + 977, (r >> 1) + 311) < share;
}

/** How far an ink dot is tinted to the accent while working: energy · min(1, 2.2·level). */
export function inkTint(energy: number, level: number): number {
  return energy * Math.min(1, 2.2 * level);
}

/** The least ms between frames: ~15 fps while working or settling, the rest rate otherwise. */
export function backdropFrameMs(target: number, energy: number): number {
  return target > 0 || energy > ENERGY_EPS ? WORKING_FRAME_MS : FX_REST_MS;
}

/** The moving state of the backdrop: integrated drift and flow clocks, and the energy. */
export interface BackdropState {
  /** Drift time (s, scaled by driftRate as it is integrated). */
  driftT: number;
  /** Noise offset (integrated flowRate). */
  flowT: number;
  energy: number;
}

/**
 * The level at a css-px point — the mock's `level()` for variant `mine`, written plainly. The fast
 * renderer below must agree with it cell for cell (tests pin that).
 */
export function backdropLevel(x: number, y: number, w: number, h: number, s: BackdropState, band: ColumnBand = columnBand(w)): number {
  const n = fbm(x * BACKDROP_NOISE_SCALE + s.flowT, y * BACKDROP_NOISE_SCALE - s.flowT * 0.6);
  let falloff = 0;
  for (let i = 0; i < BACKDROP_BLOBS.length; i++) {
    const [bx, by] = blobAt(BACKDROP_BLOBS[i]!, w, h, s.driftT);
    const dx = x - bx;
    const dy = y - by;
    falloff = Math.max(falloff, patchFalloff(Math.sqrt(dx * dx + dy * dy) / blobRadius(i, s.energy)));
  }
  return patchLevel(falloff, n) * clearFactor(x, band);
}

/** Low/high bounds of (0.55 + 0.75·fbm): fbm stays in [0, 1). */
const NOISE_LO = 0.55;
const NOISE_HI = 1.3;

/** Per-size data, computed once per resize: the column factor per column and the accent clumps. */
export interface BackdropGrid {
  w: number;
  h: number;
  cell: number;
  cols: number;
  rows: number;
  /** clearFactor of each column's centre. */
  clear: Float64Array;
  /** 1 where the cell is an accent dot. */
  accent: Uint8Array;
  /**
   * Per (row & 3, column): below this (1 − d) the cell can't pass its Bayer threshold whatever the
   * noise — (th / (1.3·clear))^(1/1.4), a hair lowered so rounding never culls a cell that could pass.
   */
  cut: Float64Array;
}

export function backdropGrid(w: number, h: number, cell: number = BACKDROP_CELL): BackdropGrid {
  const cols = Math.max(0, Math.ceil(w / cell));
  const rows = Math.max(0, Math.ceil(h / cell));
  const band = columnBand(w);
  const clear = new Float64Array(cols);
  for (let c = 0; c < cols; c++) clear[c] = clearFactor(c * cell + cell / 2, band);
  const accent = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) accent[r * cols + c] = accentCell(c, r) ? 1 : 0;
  const cut = new Float64Array(4 * cols);
  for (let p = 0; p < 4; p++) {
    for (let c = 0; c < cols; c++) cut[p * cols + c] = Math.pow(BAYER4[p * 4 + (c & 3)]! / (NOISE_HI * clear[c]!), 1 / 1.4) * (1 - 1e-9);
  }
  return { w, h, cell, cols, rows, clear, accent, cut };
}

/**
 * fbm along one row, bit for bit the same as `fbm(x, y)` of fx/noise: the row's y terms are worked
 * out once, and the four corner hashes of each octave are kept while x stays in the same lattice cell
 * (≈ 30 cells for the first octave), so most cells cost a few multiplications instead of eight hashes.
 */
class RowNoise {
  private yi1 = 0; private v1 = 0; private yi2 = 0; private v2 = 0;
  private xi1 = NaN; private a1 = 0; private b1 = 0; private c1 = 0; private d1 = 0;
  private xi2 = NaN; private a2 = 0; private b2 = 0; private c2 = 0; private d2 = 0;

  row(y: number): void {
    this.yi1 = Math.floor(y);
    let f = y - this.yi1;
    this.v1 = f * f * (3 - 2 * f);
    const y2 = y * 2.1 + 1.3;
    this.yi2 = Math.floor(y2);
    f = y2 - this.yi2;
    this.v2 = f * f * (3 - 2 * f);
    this.xi1 = NaN;
    this.xi2 = NaN;
  }

  at(x: number): number {
    const xi = Math.floor(x);
    if (xi !== this.xi1) {
      this.xi1 = xi;
      this.a1 = hash2(xi, this.yi1); this.b1 = hash2(xi + 1, this.yi1);
      this.c1 = hash2(xi, this.yi1 + 1); this.d1 = hash2(xi + 1, this.yi1 + 1);
    }
    let xf = x - xi;
    let u = xf * xf * (3 - 2 * xf);
    let v = this.v1;
    let a = this.a1, b = this.b1, c = this.c1, d = this.d1;
    const n1 = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    const x2 = x * 2.1 + 5.2;
    const xj = Math.floor(x2);
    if (xj !== this.xi2) {
      this.xi2 = xj;
      this.a2 = hash2(xj, this.yi2); this.b2 = hash2(xj + 1, this.yi2);
      this.c2 = hash2(xj, this.yi2 + 1); this.d2 = hash2(xj + 1, this.yi2 + 1);
    }
    xf = x2 - xj;
    u = xf * xf * (3 - 2 * xf);
    v = this.v2;
    a = this.a2; b = this.b2; c = this.c2; d = this.d2;
    const n2 = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    return n1 * 0.65 + n2 * 0.35;
  }
}

/**
 * One frame into RGBA pixels, one pixel per cell (blitted ×cell, no smoothing). The result is the
 * mock's brute-force frame (tests compare it with `backdropLevel` cell for cell), but only the cells
 * inside some patch's circle are visited (row spans from the circle equation), the nearest patch
 * wins (the falloff only grows towards a centre), cells too far out to pass their threshold are culled
 * before the pow (`cut`), and the noise is worked out only where the threshold or the tint depends
 * on it. Returns the lit cells.
 */
export function renderBackdrop(px: Uint8ClampedArray, g: BackdropGrid, s: BackdropState, ink: Rgb, accent: Rgb): number {
  const { w, h, cell, cols, rows, clear, cut } = g;
  const acc = g.accent;
  px.fill(0);
  if (cols === 0 || rows === 0) return 0;
  const e = s.energy;
  const half = cell / 2;
  const nb = BACKDROP_BLOBS.length;
  const bx = new Float64Array(nb);
  const by = new Float64Array(nb);
  const rad = new Float64Array(nb);
  const r2 = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    const [x, y] = blobAt(BACKDROP_BLOBS[i]!, w, h, s.driftT);
    const r = blobRadius(i, e);
    bx[i] = x; by[i] = y; rad[i] = r; r2[i] = r * r;
  }
  const accentA = 255 * (BACKDROP_INK_ALPHA * BACKDROP_ACCENT_GAIN + BACKDROP_WORK_ALPHA * e);
  const flow = s.flowT;
  const noise = new RowNoise();
  const dy = new Float64Array(nb);
  const on = new Uint8Array(nb);
  const s0 = new Int32Array(nb);
  const s1 = new Int32Array(nb);
  let lit = 0;
  for (let r = 0; r < rows; r++) {
    const y = r * cell + half;
    // The row's span inside each circle, sorted by start (at most three; overlaps are skipped below).
    let n = 0;
    for (let i = 0; i < nb; i++) {
      const dyi = y - by[i]!;
      on[i] = 0;
      if (dyi * dyi >= r2[i]!) continue;
      const hw = Math.sqrt(r2[i]! - dyi * dyi);
      const c0 = Math.max(0, Math.ceil((bx[i]! - hw - half) / cell));
      const c1 = Math.min(cols - 1, Math.floor((bx[i]! + hw - half) / cell));
      if (c0 > c1) continue;
      on[i] = 1; dy[i] = dyi;
      let k = n++;
      while (k > 0 && s0[k - 1]! > c0) { s0[k] = s0[k - 1]!; s1[k] = s1[k - 1]!; k--; }
      s0[k] = c0; s1[k] = c1;
    }
    if (n === 0) continue;
    noise.row(y * BACKDROP_NOISE_SCALE - flow * 0.6);
    const brow = (r & 3) * 4;
    const cutRow = (r & 3) * cols;
    const rowBase = r * cols;
    let next = 0;
    for (let k = 0; k < n; k++) {
      const from = Math.max(s0[k]!, next);
      const to = s1[k]!;
      if (to < from) continue;
      next = to + 1;
      for (let c = from; c <= to; c++) {
        const x = c * cell + half;
        // The nearest patch (normalised): its falloff is the largest one.
        let dmin = 1;
        for (let i = 0; i < nb; i++) {
          if (!on[i]) continue;
          const dx = x - bx[i]!;
          const d = Math.sqrt(dx * dx + dy[i]! * dy[i]!) / rad[i]!;
          if (d < dmin) dmin = d;
        }
        if (dmin >= 1 || 1 - dmin < cut[cutRow + c]!) continue; // too faint here to ever pass
        const f = patchFalloff(dmin);
        const k2 = clear[c]!;
        const th = BAYER4[brow + (c & 3)]!;
        if (f * NOISE_HI * k2 <= th) continue; // can't pass, whatever the noise
        const idx = rowBase + c;
        const isAccent = acc[idx] === 1;
        const lo = f * NOISE_LO * k2;
        let tint = isAccent ? 1 : e > 0 && lo * 2.2 >= 1 ? e : 0;
        if (lo <= th || (!isAccent && e > 0 && lo * 2.2 < 1)) {
          const lv = patchLevel(f, noise.at(x * BACKDROP_NOISE_SCALE + flow)) * k2;
          if (lv <= th) continue;
          if (!isAccent) tint = inkTint(e, lv);
        }
        const o = idx * 4;
        lit++;
        if (isAccent) {
          px[o] = accent[0]; px[o + 1] = accent[1]; px[o + 2] = accent[2]; px[o + 3] = accentA;
        } else {
          px[o] = ink[0] + (accent[0] - ink[0]) * tint;
          px[o + 1] = ink[1] + (accent[1] - ink[1]) * tint;
          px[o + 2] = ink[2] + (accent[2] - ink[2]) * tint;
          px[o + 3] = 255 * (BACKDROP_INK_ALPHA + BACKDROP_WORK_ALPHA * tint);
        }
      }
    }
  }
  return lit;
}
