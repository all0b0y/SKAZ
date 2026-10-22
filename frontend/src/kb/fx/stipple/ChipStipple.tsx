import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { FxCanvas } from '../FxCanvas';
import { drawLensDots } from './draw';
import { chipLens, lensDots, stepHover, stipplePoints, type Pt } from './stipple';

/** After the pointer leaves the dots settle back in ~0.3 s; the canvas goes away once they are still. */
const SETTLE_MS = 450;

/**
 * Citation-chip hover: dots in a lens around the chip are pushed outward and turn to the accent.
 * Render it INSIDE the chip's button (`position: relative`); the CSS puts the canvas behind the chip
 * and the text (z-index -1, pointer-events none, 40 px / 30 px of room around) — the text container
 * must be `isolation: isolate` (cite.css). Mounted only while the chip is hovered or focused (and
 * while it settles); nothing at all under reduced motion. The loop runs only while the dots move:
 * once they are in place (a pinned popover keeps the chip on) it stops, and a change of `on` starts
 * it again. Off-screen / hidden window: FxCanvas pauses it.
 */
export function ChipStipple({ on }: { on: boolean }) {
  const reduced = useReducedMotion() ?? false;
  const [settling, setSettling] = useState(false);
  const [moving, setMoving] = useState(true);
  useEffect(() => {
    setMoving(true);
    if (on) { setSettling(true); return undefined; }
    const id = window.setTimeout(() => setSettling(false), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [on]);
  const onRef = useRef(on);
  onRef.current = on;
  const hover = useRef(0);
  const cache = useRef<{ w: number; h: number; pts: Pt[] } | null>(null);
  if (reduced || (!on && !settling)) return null;
  return (
    <FxCanvas className="kb-fx-stip kb-fx-stip--chip" active={moving} reduced={false}
      onFrame={(ctx, w, h, _t, dt, colors) => {
        const target = onRef.current ? 1 : 0;
        hover.current = stepHover(hover.current, target, dt);
        if (!cache.current || cache.current.w !== w || cache.current.h !== h) cache.current = { w, h, pts: stipplePoints(w, h) };
        drawLensDots(ctx, lensDots(cache.current.pts, chipLens(w / 2, h / 2, hover.current)), colors);
        // In place: stop the loop. The frame stays on the canvas; a repaint (resize, theme) draws the same one.
        if (dt > 0 && hover.current === target) setMoving(false);
      }} />
  );
}
