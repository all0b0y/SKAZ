import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { FxCanvas } from '../FxCanvas';
import { drawLensDots } from './draw';
import { lensDots, stipplePoints, toastLens, TOAST_DURATION_S, type Pt } from './stipple';

/** Toast dots sit outside the toast, left of its edge; the lens is centred this far beyond the edge. */
const EDGE_GAP = 2;

/**
 * The toast's arrival: a short, subtle shimmer of dots around its LEFT edge (radius 8 → 26 px over
 * 0.9 s, displacement 3 px, ~1 s in all, no ring). Render it inside the toast; the CSS puts the
 * canvas to the left of the toast body, so it never touches the text. Once per mount (a new toast
 * remounts it); nothing under reduced motion.
 */
export function ToastStipple() {
  const reduced = useReducedMotion() ?? false;
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setPlaying(false), TOAST_DURATION_S * 1000 + 100);
    return () => window.clearTimeout(id);
  }, []);
  const cache = useRef<{ w: number; h: number; pts: Pt[] } | null>(null);
  if (reduced || !playing) return null;
  return (
    <FxCanvas className="kb-fx-stip kb-fx-stip--toast" active reduced={false}
      onFrame={(ctx, w, h, t, _dt, colors) => {
        const lens = toastLens(w - EDGE_GAP, h / 2, t);
        if (!lens) return;
        if (!cache.current || cache.current.w !== w || cache.current.h !== h) cache.current = { w, h, pts: stipplePoints(w, h) };
        drawLensDots(ctx, lensDots(cache.current.pts, lens), colors);
      }} />
  );
}
