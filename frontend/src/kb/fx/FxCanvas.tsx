import { useCallback, useEffect, useRef, useState } from 'react';
import { readFxColors, type FxColors } from './colors';
import { useFxLoop } from './loop';

export type FxFrame = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, dt: number, colors: FxColors) => void;

export interface FxCanvasProps {
  className?: string;
  /**
   * Backing-store scale. 1 (default) = CSS-px resolution, half resolution on Retina, by design;
   * 2 only for tiny indicators (≤ 100×20 css px) where a 2-px pixel must stay sharp.
   */
  dpr?: 1 | 2;
  active: boolean;
  reduced: boolean;
  /** Draws one frame in CSS px on a cleared canvas; `colors` follow the theme. */
  onFrame: FxFrame;
  /** The time of the reduced-motion still frame (seconds). */
  stillT?: number;
  /** A change repaints at once (e.g. a font arrived and the still frame must be redrawn). */
  redrawKey?: unknown;
  /** The least ms between frames, or a function asked every tick (see useFxLoop). Default ~30 fps. */
  frameMs?: number | (() => number);
}

/**
 * One decorative effect canvas (FX-EFFECTS-SPEC «Core module API»). Sized by its CSS box through a
 * ResizeObserver, `aria-hidden`, safe where there is no 2D context (jsdom: getContext → null, nothing
 * is drawn), and it re-reads the theme colours when html[data-theme] or the system scheme changes.
 *
 * Its loop runs only while it can be seen: `active`, the window not hidden (useFxLoop), and the canvas
 * intersecting the viewport — an IntersectionObserver on the canvas itself stops it off-screen, in a
 * scrolled-away row or inside a `hidden` section (review Q4), so every effect gets this for free.
 */
export function FxCanvas({ className, dpr = 1, active, reduced, onFrame, stillT = 4, redrawKey, frameMs }: FxCanvasProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  /** undefined = not asked yet; null = this environment has no 2D canvas (asked once, not per frame). */
  const ctxRef = useRef<CanvasRenderingContext2D | null | undefined>(undefined);
  const sizeRef = useRef({ w: 0, h: 0 });
  const colorsRef = useRef<FxColors | null>(null);
  const lastT = useRef(stillT);
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  const still = reduced ? stillT : null;
  /** The canvas intersects the viewport (true until the first IntersectionObserver answer, and where there is none). */
  const [onScreen, setOnScreen] = useState(true);

  const paint = useCallback((dt: number, t: number) => {
    const canvas = ref.current;
    const { w, h } = sizeRef.current;
    if (!canvas || w <= 0 || h <= 0) return;
    if (ctxRef.current === undefined) ctxRef.current = canvas.getContext('2d');
    const ctx = ctxRef.current;
    if (!ctx) return;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    colorsRef.current ??= readFxColors(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    lastT.current = t;
    frameRef.current(ctx, w, h, t, dt, colorsRef.current);
  }, [dpr]);

  /** Repaint the current moment (resize, theme, redrawKey): the still frame, or the last loop time. */
  const repaint = useCallback(() => paint(0, still ?? lastT.current), [paint, still]);

  useFxLoop(paint, { active: active && onScreen, reduced, fixedT: stillT, frameMs });

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnScreen(!!last.isIntersecting);
    });
    io.observe(canvas);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const measure = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w === sizeRef.current.w && h === sizeRef.current.h) return;
      sizeRef.current = { w, h };
      repaint(); // resizing the backing store clears it: draw again now, not on the next tick
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [repaint]);

  useEffect(() => {
    const reread = () => { colorsRef.current = null; repaint(); };
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const obs = typeof MutationObserver === 'undefined' ? null : new MutationObserver(reread);
    obs?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    mq?.addEventListener?.('change', reread);
    return () => { obs?.disconnect(); mq?.removeEventListener?.('change', reread); };
  }, [repaint]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (redrawKey !== undefined) repaint(); }, [redrawKey]);

  return <canvas ref={ref} className={className ? `kb-fx ${className}` : 'kb-fx'} aria-hidden="true" />;
}
