import { useEffect, useState } from 'react';
import type { MotionLevel } from '../../ui/motionLevel';

/*
 * Stage 6 B6 — the timing of a PixelTransition swap (demo motion-v1 B6): at «full» the cells cover the
 * old content for 350 ms, the content swaps under the full cover, the cells uncover the new one for
 * 350 ms; at «calm» a plain crossfade (120 ms out, 160 ms in); at «off» the new value shows at once.
 * Every swap that played (at any level) is counted, so the caller can say what happened in words.
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
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * `value` is what should be on screen; `plays(shown, next)` says whether this change is one to show
 * (the agent changed the open page) — anything else replaces the value at once, without motion.
 * Returns the value to render now, the phase and when it began, and how many swaps played.
 */
export function usePixelSwap<T>(value: T, plays: (shown: T, next: T) => boolean, level: MotionLevel) {
  const [state, setState] = useState<SwapState<T>>(() => ({ shown: value, pending: null, phase: 'idle', phaseAt: 0, played: 0 }));
  let s = state;
  const waiting = s.pending !== null && Object.is(s.pending.value, value);
  if (!Object.is(value, s.shown) && !waiting) {
    // Derived state, set during render: the new value never paints before its cover starts.
    if (s.phase === 'cover' || s.phase === 'fade-out') s = { ...s, pending: { value } };
    else if (!plays(s.shown, value)) s = { ...s, shown: value };
    else if (level === 'off') s = { ...s, shown: value, phase: 'idle', played: s.played + 1 };
    else s = { ...s, pending: { value }, phase: level === 'full' ? 'cover' : 'fade-out', phaseAt: now() };
    setState(s);
  }

  useEffect(() => {
    const step: Partial<Record<PixelPhase, [number, (p: SwapState<T>) => SwapState<T>]>> = {
      cover: [PIXEL_HALF_MS, (p) => ({ ...p, shown: p.pending ? p.pending.value : p.shown, pending: null, phase: 'reveal', phaseAt: now() })],
      reveal: [PIXEL_HALF_MS, (p) => ({ ...p, phase: 'idle', played: p.played + 1 })],
      'fade-out': [CALM_OUT_MS, (p) => ({ ...p, shown: p.pending ? p.pending.value : p.shown, pending: null, phase: 'fade-in', phaseAt: now() })],
      'fade-in': [CALM_IN_MS, (p) => ({ ...p, phase: 'idle', played: p.played + 1 })],
    };
    const next = step[state.phase];
    if (!next) return undefined;
    const id = setTimeout(() => setState(next[1]), next[0]);
    return () => clearTimeout(id);
  }, [state.phase, state.phaseAt]);

  return { shown: s.shown, phase: s.phase, phaseAt: s.phaseAt, played: s.played };
}
