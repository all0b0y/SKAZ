import { useEffect, useRef } from 'react';

/** Frames closer than this are skipped: ~30 fps is enough for 1-bit effects and halves the cost. */
export const FX_FRAME_MS = 31;
/** An effect at rest (only a slow drift moves) redraws this rarely: ≤ 4 fps (review Q3). */
export const FX_REST_MS = 250;
/** One long frame (a stall, a breakpoint) never jumps an effect forward by more than this. */
const MAX_DT = 0.1;

export interface FxLoopOptions {
  active: boolean;
  reduced: boolean;
  /** The time of the still frame drawn under reduced motion (seconds). */
  fixedT?: number;
  /**
   * The least time between two drawn frames (ms), FX_FRAME_MS by default. A function is asked on
   * every tick, so an effect can slow down at rest and speed up at once when something moves.
   */
  frameMs?: number | (() => number);
}

/**
 * The single throttled animation loop of an effect (FX-EFFECTS-SPEC «Core module API»).
 * `draw(dt, t)`: dt = seconds since the last drawn frame (0 on the first), t = the effect clock (s).
 * Paused while the window is hidden; stops when inactive or unmounted. The clock pauses with the loop
 * and goes on from the same moment when it runs again (no restart at 0, no jump: review Q16). Under
 * reduced motion it draws one still frame `draw(0, fixedT)` per activation and runs no loop.
 */
export function useFxLoop(draw: (dt: number, t: number) => void, opts: FxLoopOptions): void {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const frameMsRef = useRef(opts.frameMs);
  frameMsRef.current = opts.frameMs;
  const clock = useRef(0);
  const { active, reduced, fixedT = 4 } = opts;

  useEffect(() => {
    if (!active) return undefined;
    if (reduced) {
      drawRef.current(0, fixedT);
      return undefined;
    }
    let raf = 0;
    let last = -1;
    const minGap = () => {
      const f = frameMsRef.current;
      return typeof f === 'function' ? f() : f ?? FX_FRAME_MS;
    };
    const tick = (now: number) => {
      raf = 0;
      // Hidden: no frames at all; visibilitychange restarts the loop (Electron may not throttle rAF).
      if (document.hidden) { last = -1; return; }
      raf = requestAnimationFrame(tick);
      // The first frame of a run repaints the moment the clock stopped at: nothing jumps.
      if (last < 0) { last = now; drawRef.current(0, clock.current); return; }
      const gap = now - last;
      const min = minGap();
      if (gap < min) return;
      last = now;
      // A slow (rest) rate still advances by the real gap; only a stall is capped.
      const dt = Math.min(Math.max(MAX_DT, (min * 1.5) / 1000), gap / 1000);
      clock.current += dt;
      drawRef.current(dt, clock.current);
    };
    const onVisible = () => { if (!document.hidden && !raf) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, reduced, fixedT]);
}
