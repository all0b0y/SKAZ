import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FxCanvas } from '../FxCanvas';
import { useServices } from '../../state/context';
import { useMotionLevel } from '../../ui/motionLevel';
import { sessionSlot } from '../session';
import { HALFTONE_DONE_S, drawHalftone, halftoneDots, type HalftoneDot } from './halftone';
import '../halftone.css';

/** Calm: the finished image fades in this long (ms). */
export const HALFTONE_FADE_MS = 200;
/** The scale of the drawing in a compact (side panel) empty state. */
const COMPACT_SCALE = 0.7;
/** Renders of one empty state closer than this to its first are the same showing (StrictMode). */
const REPEAT_MS = 100;

/**
 * The empty-state art (HalftoneReveal, stage 6 B11): drawn once in halftone dots from the centre
 * (full), faded in finished (calm) or still (off). «Once» is per app session and per empty state
 * (`id`): coming back to it — a section switch, a remount — shows the still image, like the lists'
 * entrance (stage 5 rule). Decorative: aria-hidden, the title and text of the empty state say it.
 * `data-reveal` = draw | fade | still is a test/probe hook.
 */
export function HalftoneArt({ id, compact = false }: { id: string; compact?: boolean }) {
  const services = useServices();
  const level = useMotionLevel();
  // Decided once, at the first render: a later knob change does not replay or cut a drawing. The
  // session keeps when the art first showed: a render within REPEAT_MS of it is the same showing
  // (React's StrictMode renders twice in development), a later one is a comeback → still.
  const [reveal] = useState<'draw' | 'fade' | 'still'>(() => {
    const now = performance.now();
    const { value: first } = sessionSlot(services, `halftone:${id}`, () => now);
    if (now - first > REPEAT_MS || level === 'off') return 'still';
    return level === 'full' ? 'draw' : 'fade';
  });
  const [drawn, setDrawn] = useState(reveal !== 'draw');
  const wrap = useRef<HTMLSpanElement | null>(null);
  const dots = useRef<{ key: string; dots: HalftoneDot[] } | null>(null);
  const scale = compact ? COMPACT_SCALE : 1;

  // The drawing ends on the clock, not on a frame: where nothing is painted (no 2D context, the
  // window hidden) it still stops, and the loop never runs on.
  useEffect(() => {
    if (drawn) return undefined;
    const t = window.setTimeout(() => setDrawn(true), Math.ceil(HALFTONE_DONE_S * 1000) + 60);
    return () => window.clearTimeout(t);
  }, [drawn]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (reveal !== 'fade' || !el || typeof el.animate !== 'function') return undefined;
    const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: HALFTONE_FADE_MS, easing: 'ease-out' });
    return () => a.cancel();
  }, [reveal]);

  return (
    <span ref={wrap} className={`kb-empty__art${compact ? ' kb-empty__art--compact' : ''}`} data-reveal={drawn && reveal === 'draw' ? 'still' : reveal}
      aria-hidden="true">
      <FxCanvas className="kb-fx-halftone" dpr={2} active reduced={drawn} stillT={HALFTONE_DONE_S + 1}
        onFrame={(ctx, w, h, t, _dt, colors) => {
          const key = `${w}x${h}`;
          if (dots.current?.key !== key) dots.current = { key, dots: halftoneDots(w, h, scale) };
          drawHalftone(ctx, dots.current.dots, Math.min(t, HALFTONE_DONE_S + 1), colors, scale);
        }} />
    </span>
  );
}
