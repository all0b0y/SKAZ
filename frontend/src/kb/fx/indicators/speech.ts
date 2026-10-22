/*
 * «Speech» (FX-EFFECTS-SPEC Batch B1, mock `LOOP.speech`): vertical bars whose heights follow the REAL
 * input level. Nothing here moves on its own — the levels come from the recording store, silence is a
 * row of short, still bars, and a frame is drawn only when the levels change.
 */
import { clamp } from '../noise';
import { mixRgb, rgba, type FxColors } from '../colors';

export const SPEECH_W = 36;
export const SPEECH_H = 14;
/** Distance between bar origins and bar width, css px. */
export const SPEECH_STEP = 5;
export const SPEECH_BAR_W = 2.5;

/** How many bars fit a width. */
export const speechBarCount = (w: number): number => Math.max(0, Math.floor(w / SPEECH_STEP));

/**
 * `n` levels (0..1) taken from `levels` by linear interpolation across the row. Empty input or a
 * non-finite value is silence (0); one level fills the row.
 */
export function speechLevels(levels: readonly number[], n: number): number[] {
  if (n <= 0) return [];
  const at = (k: number) => {
    const v = levels[k];
    return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 0;
  };
  if (levels.length === 0) return new Array<number>(n).fill(0);
  if (levels.length === 1) return new Array<number>(n).fill(at(0));
  if (n === 1) return [Math.max(...levels.map((_, k) => at(k)))];
  return Array.from({ length: n }, (_, i) => {
    const pos = (i / (n - 1)) * (levels.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(levels.length - 1, lo + 1);
    return at(lo) + (at(hi) - at(lo)) * (pos - lo);
  });
}

/** Bar height in css px for a level: 2 px at silence, up to h - 1 at full scale. */
export const speechBarHeight = (level: number, h: number): number => 2 + clamp(level, 0, 1) * (h - 3);

/** Paint one frame from the real levels (css px; the canvas transform carries the dpr). */
export function drawSpeech(ctx: CanvasRenderingContext2D, w: number, h: number, levels: readonly number[], colors: FxColors): void {
  const lv = speechLevels(levels, speechBarCount(w));
  lv.forEach((v, i) => {
    const bh = speechBarHeight(v, h);
    ctx.fillStyle = rgba(mixRgb(colors.ink, colors.accent, v), 0.4 + 0.55 * v);
    ctx.fillRect(i * SPEECH_STEP + 1, (h - bh) / 2, SPEECH_BAR_W, bh);
  });
}
