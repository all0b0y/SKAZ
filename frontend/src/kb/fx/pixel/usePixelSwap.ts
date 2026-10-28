import { useEffect, useState } from 'react';
import type { MotionLevel } from '../../ui/motionLevel';

/*
 * Stage 6 B6 — the timing of a PixelTransition swap (demo motion-v1 B6): at «full» the cells cover the
 * old content for 350 ms, the content swaps under the full cover, the cells uncover the new one for
 * 350 ms; at «calm» a plain crossfade (120 ms out, 160 ms in); at «off» the new value shows at once.
 * Every swap that played (at any level) is counted, so the caller can say what happened in words.
 *
 * FIX2 C-L3: a swap never plays across values the caller does not want animated — another page, or
 * null while a page loads, arriving mid-swap cancels it and shows at once; and a second played change
 * during the reveal re-covers from where the reveal stood (`rewindFrom`), never from an empty cover.
 */

export const PIXEL_HALF_MS = 350;
export const CALM_OUT_MS = 120;
export const CALM_IN_MS = 160;

export type PixelPhase = 'idle' | 'cover' | 'reveal' | 'fade-out' | 'fade-in';

interface SwapState<T> {
  shown: T;
  /** The value waiting for the swap moment (the newest one, if several arrive meanwhile). */
  pending: { value: T } | null;
  phase: PixelPhase;
  /** performance.now() when the phase began (the canvas draws from it). */
  phaseAt: number;
  played: number;
  /** A cover that interrupts a reveal: how far that reveal had got (0..1); null for a plain cover. */
  rewindFrom: number | null;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * `value` is what should be on screen; `plays(shown, next)` says whether this change is one to show
 * (the agent changed the open page) — anything else replaces the value at once, without motion.
 * Returns the value to render now, the phase and when it began, and how many swaps played.
 */
export function usePixelSwap<T>(value: T, plays: (shown: T, next: T) => boolean, level: MotionLevel) {
  const [state, setState] = useState<SwapState<T>>(() => ({ shown: value, pending: null, phase: 'idle', phaseAt: 0, played: 0, rewindFrom: null }));
  let s = state;
  const waiting = s.pending !== null && Object.is(s.pending.value, value);
  const cancel = (next: SwapState<T>): SwapState<T> => ({ ...next, shown: value, pending: null, phase: 'idle', rewindFrom: null });
  if (Object.is(value, s.shown) && s.pending !== null) {
    // The value went back to the one on screen before the swap: nothing to show.
    s = cancel(s);
    setState(s);
  } else if (!Object.is(value, s.shown) && !waiting) {
    // Derived state, set during render: the new value never paints before its cover starts.
    const t = now();
    if (!plays(s.shown, value)) s = cancel(s); // not a change to animate (another page, loading): at once
    else if (s.phase === 'cover' || s.phase === 'fade-out') s = { ...s, pending: { value } };
    else if (level === 'off') s = { ...s, shown: value, phase: 'idle', played: s.played + 1, rewindFrom: null };
    else if (s.phase === 'reveal' && level === 'full') {
      // Re-cover from where the reveal stands: the same cells, played backwards (pixelFrame).
      const rewindFrom = Math.min(1, Math.max(0, (t - s.phaseAt) / PIXEL_HALF_MS));
      s = { ...s, pending: { value }, phase: 'cover', phaseAt: t, rewindFrom };
    } else s = { ...s, pending: { value }, phase: level === 'full' ? 'cover' : 'fade-out', phaseAt: t, rewindFrom: null };
    setState(s);
  }

  useEffect(() => {
    const step: Partial<Record<PixelPhase, [number, (p: SwapState<T>) => SwapState<T>]>> = {
      cover: [state.rewindFrom === null ? PIXEL_HALF_MS : state.rewindFrom * PIXEL_HALF_MS,
        (p) => ({ ...p, shown: p.pending ? p.pending.value : p.shown, pending: null, phase: 'reveal', phaseAt: now(), rewindFrom: null })],
      reveal: [PIXEL_HALF_MS, (p) => ({ ...p, phase: 'idle', played: p.played + 1 })],
      'fade-out': [CALM_OUT_MS, (p) => ({ ...p, shown: p.pending ? p.pending.value : p.shown, pending: null, phase: 'fade-in', phaseAt: now() })],
      'fade-in': [CALM_IN_MS, (p) => ({ ...p, phase: 'idle', played: p.played + 1 })],
    };
    const next = step[state.phase];
    if (!next) return undefined;
    const id = setTimeout(() => setState(next[1]), next[0]);
    return () => clearTimeout(id);
  }, [state.phase, state.phaseAt, state.rewindFrom]);

  return { shown: s.shown, phase: s.phase, phaseAt: s.phaseAt, played: s.played, rewindFrom: s.rewindFrom };
}
