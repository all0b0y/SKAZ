import { useRef } from 'react';
import { useStillIndicators } from '../../ui/motionLevel';
import { FxCanvas } from '../FxCanvas';
import type { Pt } from '../stipple/stipple';
import { CALL_SWEEP_STILL_T, callSweepPoints, drawCallSweep } from './sweep';

/**
 * The fill of a running tool-call chip (sweep.ts). Decorative (aria-hidden): the chip's words say
 * what runs. A status indicator, so it keeps moving at «calm» and is one still frame at «off» or under
 * the system's reduced motion (useStillIndicators). Off-screen FxCanvas stops it.
 */
export function CallSweep({ className }: { className?: string }) {
  const still = useStillIndicators() ?? false;
  const cache = useRef<{ w: number; h: number; pts: Pt[] } | null>(null);
  return (
    <FxCanvas className={className ? `kb-fx-sweep ${className}` : 'kb-fx-sweep'} dpr={1} active reduced={still} stillT={CALL_SWEEP_STILL_T}
      onFrame={(ctx, w, h, t, _dt, colors) => {
        if (!cache.current || cache.current.w !== w || cache.current.h !== h) cache.current = { w, h, pts: callSweepPoints(w, h) };
        drawCallSweep(ctx, cache.current.pts, w, t, colors);
      }} />
  );
}
