import { mixRgb, rgba, type FxColors } from '../colors';
import { stripBandX, stripGain, stripPoints, type Pt } from '../stipple/stipple';

/**
 * A running tool call (stage 6 B3 CallChip, decision 30): the production Stippling strip drawn as the
 * chip's fill (C2: the call's «wipe» in an accepted effect style, not a fourth one). The band crosses
 * the chip a little faster than the progress strip and the dots stay quieter, so the chip's words read
 * on top. It never claims progress: the band only says «working».
 */

/** The band's speed against the progress strip (demo motion-v1 `sweep`: t × 1.4). */
export const CALL_SWEEP_SPEED = 1.4;
/** The still frame at «off» / system reduced motion: the band rests a third of the way in. */
export const CALL_SWEEP_STILL_T = 1.1;

/** The chip's dots: the strip's scatter over the whole chip (~one dot per 2.2 px of width). */
export function callSweepPoints(w: number, h: number): Pt[] {
  return stripPoints(w, h);
}

/** Dot radius and alpha for a band gain v: nearly invisible at rest, the band lights them. */
export function callSweepDot(v: number): { radius: number; alpha: number } {
  return { radius: 0.8 + v * 0.4, alpha: 0.06 + 0.42 * v };
}

export function drawCallSweep(ctx: CanvasRenderingContext2D | null, points: ReadonlyArray<Pt>, w: number, t: number, colors: FxColors): void {
  if (!ctx) return;
  const bx = stripBandX(t * CALL_SWEEP_SPEED, w);
  for (const [x, y] of points) {
    const v = stripGain(x, bx, w);
    const s = callSweepDot(v);
    ctx.fillStyle = rgba(mixRgb(colors.ink, colors.accent, v), s.alpha);
    ctx.beginPath();
    ctx.arc(x, y, s.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}
