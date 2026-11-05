import { useStillIndicators } from '../../ui/motionLevel';
import { useRef } from 'react';

import { FxCanvas } from '../FxCanvas';
import { drawStrip } from './draw';
import { stripPoints, STRIP_HEIGHT, type Pt } from './stipple';

/** The reduced-motion still frame: the band rests just left of the middle (0.475 w). */
const STRIP_STILL_T = 1.5;

/**
 * A 6-px progress strip: optional measured fraction, otherwise an indeterminate moving gaussian
 * band. Show it only while the thing is in a running status ("Queued", "Processing…", "Recording…"),
 * INSTEAD of a spinner — the status text stays beside/above it and keeps its role=status.
 * It is a block of its own (`.kb-stipstrip`, aria-hidden). Backing store at dpr 1: it spans a whole
 * row (spec: dpr 2 only for ≤ 100×20 css indicators). Reduced motion keeps the strip but draws one
 * still frame. Off-screen, in a hidden section or a hidden window FxCanvas stops its loop.
 */
export function StippleStrip({ className, value }: { className?: string; value?: number | null }) {
  const progress = value != null && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  const reduced = useStillIndicators() ?? false;
  const cache = useRef<{ w: number; pts: Pt[] } | null>(null);
  return (
    <span className={className ? `kb-stipstrip ${className}` : 'kb-stipstrip'} aria-hidden="true" data-stipple-strip="" data-progress={progress ?? undefined}>
      <FxCanvas className="kb-fx-stip kb-fx-stip--strip" dpr={1} active reduced={reduced} redrawKey={progress} stillT={STRIP_STILL_T}
        onFrame={(ctx, w, h, t, _dt, colors) => {
          if (!cache.current || cache.current.w !== w) cache.current = { w, pts: stripPoints(w, Math.min(h, STRIP_HEIGHT)) };
          drawStrip(ctx, cache.current.pts, w, t, colors, progress);
        }} />
    </span>
  );
}
