import { useEffect, useRef } from 'react';
import { cssColor } from '../../ui/color';
import { readFxColors } from '../colors';
import { drawPixelCover, PIXEL_CELL, pixelField, pixelFrame, type PixelField } from './pixel';
import type { PixelPhase } from './usePixelSwap';

const LIGHT_PANE = [255, 255, 251] as const;

/**
 * The PixelTransition canvas (pixel.ts) over a positioned stage, the size of the stage's visible box
 * (not the scrolled content): cells cover during `cover`, uncover during `reveal`. Decorative
 * (aria-hidden), never takes the pointer. Mounted only while a swap plays at motion «full»; the timing
 * lives in usePixelSwap, the canvas only draws the moment of the phase it is told.
 */
export function PixelCover({ phase, phaseAt, rewindFrom = null }: { phase: PixelPhase; phaseAt: number; rewindFrom?: number | null }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const fieldRef = useRef<{ w: number; h: number; field: PixelField } | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d') ?? null;
    if (!canvas || !ctx || (phase !== 'cover' && phase !== 'reveal')) return undefined;
    const box = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (!fieldRef.current || fieldRef.current.w !== w || fieldRef.current.h !== h) {
      fieldRef.current = { w, h, field: pixelField(Math.ceil(w / PIXEL_CELL), Math.ceil(h / PIXEL_CELL)) };
    }
    const pane = cssColor(canvas, '--kb-pane');
    const colors = {
      pane: pane ? [Math.round(pane.r * 255), Math.round(pane.g * 255), Math.round(pane.b * 255)] as const : LIGHT_PANE,
      accent: readFxColors(canvas).accent,
    };
    const field = fieldRef.current.field;
    let raf = 0;
    const frame = () => {
      const f = pixelFrame(phase, performance.now() - phaseAt, rewindFrom);
      drawPixelCover(ctx, field, w, h, f.threshold, f.covering, colors);
      // The cover holds full until the swap; the reveal ends when the phase does (usePixelSwap).
      if (!f.done) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [phase, phaseAt, rewindFrom]);
  return <canvas ref={ref} className="kb-pxcover" aria-hidden="true" />;
}
