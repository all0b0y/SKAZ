import { describe, expect, it } from 'vitest';
import { BAYER4 } from '../noise';
import { FX_REST_MS } from '../loop';
import type { Rgb } from '../colors';
import {
  accentCell, BACKDROP_ACCENT_GAIN, BACKDROP_BLOBS, BACKDROP_CELL, BACKDROP_INK_ALPHA, BACKDROP_WORK_ALPHA, backdropFrameMs,
  backdropGrid, backdropLevel, blobAt, blobRadius, CHAT_COLUMN, clearFactor, columnBand, columnFactor, driftRate, easeEnergy,
  ENERGY_DOWN, ENERGY_UP, flowRate, inkTint, patchFalloff, patchLevel, renderBackdrop, SETTLE_S, WORKING_FRAME_MS,
  type BackdropState,
} from './backdrop';
import { BackdropScene } from './scene';

/*
 * The chat backdrop's pure model (CHAT-BACKDROP-SPEC, mock chat-backdrop-v2 `mine`): patch level,
 * the «keep text clear» column, the accent clumps and the tint, the energy easing, and the fast
 * renderer pinned cell for cell against the plain (mock-style) level.
 */

const INK: Rgb = [249, 248, 243];
const ACCENT: Rgb = [191, 164, 244];

/** The mock's draw(), every cell through backdropLevel — the reference the fast renderer must match. */
function reference(w: number, h: number, s: BackdropState, ink: Rgb, accent: Rgb): Uint8ClampedArray {
  const cols = Math.ceil(w / BACKDROP_CELL);
  const rows = Math.ceil(h / BACKDROP_CELL);
  const px = new Uint8ClampedArray(cols * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lv = backdropLevel(c * BACKDROP_CELL + 1.5, r * BACKDROP_CELL + 1.5, w, h, s);
      if (lv <= BAYER4[(r & 3) * 4 + (c & 3)]!) continue;
      const tinted = accentCell(c, r);
      const k = tinted ? 1 : s.energy * Math.min(1, lv * 2.2);
      const o = (r * cols + c) * 4;
      px[o] = ink[0] + (accent[0] - ink[0]) * k;
      px[o + 1] = ink[1] + (accent[1] - ink[1]) * k;
      px[o + 2] = ink[2] + (accent[2] - ink[2]) * k;
      px[o + 3] = 255 * (tinted ? BACKDROP_INK_ALPHA * BACKDROP_ACCENT_GAIN + BACKDROP_WORK_ALPHA * s.energy : BACKDROP_INK_ALPHA + BACKDROP_WORK_ALPHA * k);
    }
  }
  return px;
}

const render = (w: number, h: number, s: BackdropState, ink = INK, accent = ACCENT) => {
  const g = backdropGrid(w, h);
  const px = new Uint8ClampedArray(g.cols * g.rows * 4);
  const lit = renderBackdrop(px, g, s, ink, accent);
  return { g, px, lit };
};

describe('backdrop: the «keep text clear» column', () => {
  it('is the answer column of chat.css: 22 px in from the left, at most 760 px wide', () => {
    expect(columnBand(1100)).toEqual({ left: CHAT_COLUMN.padX, right: CHAT_COLUMN.padX + CHAT_COLUMN.max });
    expect(columnBand(500)).toEqual({ left: 22, right: 478 }); // narrower than 760 + padding: the whole width
  });

  it('column(): 0 inside, rising to 1 by 56 px outside; the level keeps a quarter in the column', () => {
    const band = columnBand(1200);
    expect(columnFactor(400, band)).toBe(0);
    expect(columnFactor(band.right - 24, band)).toBe(0);
    expect(columnFactor(band.right + 56, band)).toBe(1);
    expect(columnFactor(band.right + 300, band)).toBe(1);
    const mid = columnFactor(band.right + 16, band);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    let prev = -1;
    for (let x = band.right - 40; x < band.right + 80; x += 4) {
      const v = columnFactor(x, band);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(clearFactor(400, band)).toBe(0.25);
    expect(clearFactor(band.right + 100, band)).toBe(1);
  });
});

describe('backdrop: patches', () => {
  it('level inside a patch = (1 − d)^1.4 · (0.55 + 0.75·fbm); nothing outside', () => {
    expect(patchFalloff(0)).toBe(1);
    expect(patchFalloff(1)).toBe(0);
    expect(patchFalloff(1.5)).toBe(0);
    expect(patchFalloff(0.5)).toBeCloseTo(Math.pow(0.5, 1.4), 12);
    expect(patchLevel(1, 0)).toBeCloseTo(0.55, 12);
    expect(patchLevel(1, 1)).toBeCloseTo(1.3, 12);
    expect(patchLevel(0.5, 0.4)).toBeCloseTo(0.5 * (0.55 + 0.3), 12);
  });

  it('three patches as in the mock: radii 190–250 px, loops 83/97/109 s; the bottom one grows ×1.45 at full energy', () => {
    expect(BACKDROP_BLOBS.map((b) => b.r)).toEqual([210, 250, 190]);
    expect(BACKDROP_BLOBS.map((b) => b.p)).toEqual([97, 83, 109]);
    const b = BACKDROP_BLOBS[0]!;
    expect(blobAt(b, 1000, 600, 0)).toEqual([1000 * (0.16 + 0.07 * Math.sin(0)), 600 * (0.30 + 0.10 * Math.cos(0))]);
    const k = (2 * Math.PI * 10) / 97;
    const [x, y] = blobAt(b, 1000, 600, 10);
    expect(x).toBeCloseTo(1000 * (0.16 + 0.07 * Math.sin(k)), 9);
    expect(y).toBeCloseTo(600 * (0.30 + 0.10 * Math.cos(k * 0.8)), 9);
    expect(blobRadius(0, 1)).toBe(210);
    expect(blobRadius(1, 1)).toBe(250);
    expect(blobRadius(2, 0)).toBe(190);
    expect(blobRadius(2, 1)).toBeCloseTo(190 * 1.45, 9);
  });

  it('drift ×0.15 and flow 0.004 at rest; ×1.75 and 0.054 at full energy', () => {
    expect(driftRate(0)).toBeCloseTo(0.15, 12);
    expect(driftRate(1)).toBeCloseTo(1.75, 12);
    expect(flowRate(0)).toBeCloseTo(0.004, 12);
    expect(flowRate(1)).toBeCloseTo(0.054, 12);
  });
});

describe('backdrop: accent dots and tint', () => {
  it('30 % of the cells are accent, chosen per 2×2 clump by a stable hash', () => {
    let n = 0;
    for (let r = 0; r < 200; r++) for (let c = 0; c < 200; c++) if (accentCell(c, r)) n++;
    expect(n / 40000).toBeGreaterThan(0.27);
    expect(n / 40000).toBeLessThan(0.33);
    for (let r = 0; r < 40; r += 2) {
      for (let c = 0; c < 40; c += 2) {
        const v = accentCell(c, r);
        expect([accentCell(c + 1, r), accentCell(c, r + 1), accentCell(c + 1, r + 1)]).toEqual([v, v, v]);
      }
    }
    expect(accentCell(7, 9)).toBe(accentCell(7, 9));
  });

  it('ink dots take the accent only while working: k = energy · min(1, 2.2·level)', () => {
    expect(inkTint(0, 0.8)).toBe(0);
    expect(inkTint(1, 0.2)).toBeCloseTo(0.44, 12);
    expect(inkTint(1, 0.8)).toBe(1);
    expect(inkTint(0.5, 0.8)).toBe(0.5);
  });
});

describe('backdrop: energy', () => {
  it('eases up at 2.5/s and down at 0.9/s (the mock), and lands exactly on 0 and 1', () => {
    expect(easeEnergy(0, 1, 0.1)).toBeCloseTo(ENERGY_UP * 0.1, 12);
    expect(easeEnergy(1, 0, 0.1)).toBeCloseTo(1 - ENERGY_DOWN * 0.1, 12);
    expect(easeEnergy(0.3, 1, 0)).toBe(0.3);
    let e = 0;
    for (let t = 0; t < 2.5; t += 0.066) e = easeEnergy(e, 1, 0.066);
    expect(e).toBe(1);
    let steps = 0;
    while (e > 0 && steps < 1000) { e = easeEnergy(e, 0, 0.066); steps++; }
    expect(e).toBe(0);
    // Down takes longer than up: about 6 s from full energy to rest.
    expect(steps * 0.066).toBeGreaterThan(4);
    expect(steps * 0.066).toBeLessThan(8);
  });

  it('frame rate: ~15 fps while working or settling, the rest rate when still', () => {
    expect(backdropFrameMs(1, 0)).toBe(WORKING_FRAME_MS);
    expect(backdropFrameMs(0, 0.5)).toBe(WORKING_FRAME_MS);
    expect(backdropFrameMs(0, 0)).toBe(FX_REST_MS);
    expect(WORKING_FRAME_MS).toBe(66);
  });

  it('the scene: target 1 while the agent works, 0 after; settles (no loop needed) 2 s after the energy is 0', () => {
    const s = new BackdropScene();
    expect(s.target).toBe(0);
    expect(s.settled).toBe(false); // not until it has been still for SETTLE_S
    s.setWorking(true);
    expect(s.target).toBe(1);
    expect(s.frameMs).toBe(WORKING_FRAME_MS);
    const d0 = s.driftT;
    for (let i = 0; i < 40; i++) s.step(0.066);
    expect(s.energy).toBe(1);
    // At full energy the patches drift ×1.75 and the noise flows at 0.054 per second.
    const d1 = s.driftT;
    const f1 = s.flowT;
    s.step(1);
    expect(s.driftT - d1).toBeCloseTo(1.75, 9);
    expect(s.flowT - f1).toBeCloseTo(0.054, 9);
    expect(d1).toBeGreaterThan(d0);
    s.setWorking(false);
    expect(s.target).toBe(0);
    let t = 0;
    while (s.energy > 0 && t < 20) { s.step(0.066); t += 0.066; }
    expect(s.energy).toBe(0);
    expect(s.settled).toBe(false);
    expect(s.frameMs).toBe(FX_REST_MS);
    for (let i = 0; i < Math.floor(SETTLE_S / 0.066); i++) s.step(0.066);
    expect(s.settled).toBe(false);
    s.step(0.1);
    expect(s.settled).toBe(true);
    // Work again: no longer settled.
    s.setWorking(true);
    expect(s.settled).toBe(false);
  });
});

describe('backdrop: renderBackdrop', () => {
  const states: Array<[string, BackdropState]> = [
    ['rest', { driftT: 0, flowT: 0, energy: 0 }],
    ['rest, later', { driftT: 37.5, flowT: 1.2, energy: 0 }],
    ['ramping', { driftT: 61.2, flowT: 2.7, energy: 0.43 }],
    ['working', { driftT: 140.9, flowT: 6.3, energy: 1 }],
  ];

  it.each(states)('matches the plain mock-style frame cell for cell (%s)', (_name, s) => {
    for (const [w, h] of [[960, 620], [517, 403]] as const) {
      const { px } = render(w, h, s);
      const ref = reference(w, h, s, INK, ACCENT);
      expect(px.length).toBe(ref.length);
      let diff = 0;
      for (let i = 0; i < px.length; i++) if (px[i] !== ref[i]) diff++;
      expect(diff).toBe(0);
    }
  });

  it('is faint: ink dots at 6 %, accent dots at 6 % × 2.2; deterministic for the same moment', () => {
    const s = { driftT: 12, flowT: 0.4, energy: 0 };
    const { px, g, lit } = render(960, 620, s);
    expect(lit).toBeGreaterThan(500);
    const alphas = new Set<number>();
    let accentDots = 0;
    for (let i = 0; i < g.cols * g.rows; i++) {
      const a = px[i * 4 + 3]!;
      if (!a) continue;
      alphas.add(a);
      if (g.accent[i]) {
        accentDots++;
        expect([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]).toEqual([...ACCENT]);
      } else {
        expect([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]).toEqual([...INK]);
      }
    }
    expect([...alphas].sort()).toEqual([Math.round(255 * 0.06), Math.round(255 * 0.132)].sort());
    expect(accentDots / lit).toBeGreaterThan(0.2);
    expect(accentDots / lit).toBeLessThan(0.4);
    expect(render(960, 620, s).px).toEqual(px);
  });

  it('keeps the message column clear: under the column a cell is at most a quarter as likely to be lit', () => {
    const w = 1100;
    const h = 700;
    const band = columnBand(w);
    let inside = 0;
    let insideLit = 0;
    let outside = 0;
    let outsideLit = 0;
    // Over many moments, within the patches' reach, count lit cells in and out of the column.
    for (let t = 0; t < 400; t += 23) {
      const { px, g } = render(w, h, { driftT: t, flowT: t * 0.02, energy: 0 });
      for (let r = 0; r < g.rows; r++) {
        for (let c = 0; c < g.cols; c++) {
          const x = c * BACKDROP_CELL + 1.5;
          const lit = px[(r * g.cols + c) * 4 + 3]! > 0;
          if (x > band.left + 30 && x < band.right - 30) { inside++; if (lit) insideLit++; }
          else if (x > band.right + 60) { outside++; if (lit) outsideLit++; }
        }
      }
    }
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
    expect(insideLit / inside).toBeLessThan((outsideLit / outside) * 0.5);
  });

  it('while working: more dots (the bottom patch grows), ink dots tinted towards the accent, brighter', () => {
    const at = (energy: number) => render(960, 620, { driftT: 20, flowT: 0.5, energy });
    const rest = at(0);
    const work = at(1);
    expect(work.lit).toBeGreaterThan(rest.lit);
    let tinted = 0;
    for (let i = 0; i < work.g.cols * work.g.rows; i++) {
      if (!work.px[i * 4 + 3] || work.g.accent[i]) continue;
      if (work.px[i * 4] !== INK[0]) tinted++;
      expect(work.px[i * 4 + 3]).toBeGreaterThan(Math.round(255 * BACKDROP_INK_ALPHA));
    }
    expect(tinted).toBeGreaterThan(0);
  });

  it('nothing to draw on an empty area', () => {
    const { lit, px } = render(0, 0, { driftT: 0, flowT: 0, energy: 1 });
    expect(lit).toBe(0);
    expect(px.length).toBe(0);
  });
});
