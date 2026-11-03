import { mixRgb, rgba, type FxColors } from '../colors';
import { stripBandX, stripDotStyle, stripGain, type Pt, type StippleDot } from './stipple';

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Displaced dots only (chip, toast): ink at rest turning to the accent with the displacement. */
export function drawLensDots(ctx: CanvasRenderingContext2D | null, dots: ReadonlyArray<StippleDot>, colors: FxColors): void {
  if (!ctx) return;
  for (const d of dots) {
    ctx.fillStyle = rgba(mixRgb(colors.ink, colors.accent, d.k), 0.18 + 0.6 * d.k);
    dot(ctx, d.x, d.y, 0.8);
  }
}

/** The progress strip: every dot is always there (quiet ink); the band lights and enlarges the ones it passes. */
export function drawStrip(ctx: CanvasRenderingContext2D | null, points: ReadonlyArray<Pt>, w: number, t: number, colors: FxColors, progress?: number | null): void {
  if (!ctx) return;
  const bx = stripBandX(t, w);
  for (const [x, y] of points) {
    const measured = progress != null && Number.isFinite(progress);
    const v = !measured ? stripGain(x, bx, w)
      : progress > 0 && x <= w * progress ? 0.5 + 0.5 * stripGain(x, bx, w) : 0;
    const s = stripDotStyle(v);
    ctx.fillStyle = rgba(mixRgb(colors.ink, colors.accent, v), s.alpha);
    dot(ctx, x, y, s.radius);
  }
}
