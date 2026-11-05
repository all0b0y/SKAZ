import { useLayoutEffect, useRef, type RefObject } from 'react';
import { springEasing } from '../ui/ActiveTab';
import type { MotionLevel } from '../ui/motionLevel';

/**
 * VoicePill (stage 6, B7; DESIGN-SYSTEM.md decision 30): the title bar's Record pill swells into the
 * recording capsule and shrinks back on stop. The slot that holds the control (one element across
 * every phase) springs from the old width to the new one while it clips its content to a pill and
 * paints the new state's ground under it; the new content fades in a moment later.
 *
 * Reference: `.dev/ui-blocks/motion6/motion-v1.js` card b7 — width spring visualDuration 0.32, bounce
 * 0; content fades in 140 ms after 60 ms; calm = the capsule crossfades (160 ms, no swell); off =
 * nothing moves. The level bars are not touched here: they stay the real signal (SpeechBars).
 */

/** What the slot holds: Record | Folder, the live capsule, or the «Finishing transcript…» pill. */
export type PillShape = 'idle' | 'live' | 'finishing';

export const SWELL = springEasing(0.32, 0);
export const CONTENT_FADE_MS = 140;
export const CONTENT_DELAY_MS = 60;
export const CALM_FADE_MS = 160;

export interface SwellPlan {
  /** The slot's width keyframes (css px), or null when the width does not change. */
  width: readonly [number, number] | null;
  /** full: the new content fades in after the swell starts; calm: the whole capsule crossfades. */
  fade: 'content' | 'whole' | null;
}

/** What a change of shape plays at a motion level. Pure: widths are measured by the caller. */
export function swellPlan(level: MotionLevel, from: number, to: number): SwellPlan {
  if (level === 'off') return { width: null, fade: null };
  if (level === 'calm') return { width: null, fade: 'whole' };
  const grows = from > 0 && to > 0 && Math.abs(to - from) >= 1;
  return { width: grows ? [from, to] : null, fade: 'content' };
}

const widthOf = (el: HTMLElement) => el.getBoundingClientRect().width;

/**
 * Plays {@link swellPlan} on `slot` whenever `shape` changes (never on the first render). The slot's
 * last settled width is measured after every render and on every resize of the slot (outside a
 * swell), so a shape change knows where it came from.
 * While it swells the slot carries `is-swelling` and `data-pill` (recording.css paints the pill).
 */
export function useVoicePill(slot: RefObject<HTMLElement | null>, shape: PillShape, level: MotionLevel): void {
  const shown = useRef(shape);
  const settled = useRef(0);
  const swelling = useRef(false);
  const running = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const el = slot.current;
    if (!el) return;
    if (shown.current === shape) {
      // Mid-swell the box is the animation's, not the content's: keep the target width.
      if (!swelling.current) settled.current = widthOf(el);
      return;
    }
    shown.current = shape;
    running.current.forEach((a) => a.cancel());
    running.current = [];
    swelling.current = false;
    el.classList.remove('is-swelling');
    const from = settled.current;
    const to = widthOf(el);
    settled.current = to;
    if (typeof el.animate !== 'function') return;
    const plan = swellPlan(level, from, to);
    const played: Animation[] = [];
    if (plan.width) {
      el.dataset.pill = shape;
      el.classList.add('is-swelling');
      swelling.current = true;
      const swell = el.animate([{ width: `${plan.width[0]}px` }, { width: `${plan.width[1]}px` }],
        { duration: SWELL.duration, easing: SWELL.easing });
      const done = () => {
        if (!running.current.includes(swell)) return;
        swelling.current = false;
        el.classList.remove('is-swelling');
      };
      // `finished` rejects on cancel (a newer change took over and cleaned up already).
      swell.finished?.then(done, () => undefined);
      played.push(swell);
    }
    const content = el.firstElementChild as HTMLElement | null;
    if (plan.fade === 'content' && content && typeof content.animate === 'function') {
      played.push(content.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: CONTENT_FADE_MS, delay: CONTENT_DELAY_MS, easing: 'ease-out', fill: 'backwards' }));
    }
    if (plan.fade === 'whole') {
      played.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: CALM_FADE_MS, easing: 'ease-out' }));
    }
    running.current = played;
  });

  // FIX2 C-M4: the idle pill can change width by its own state (the saved folder name loads late)
  // without a render of the control that owns the slot: watch the slot itself. Mid-swell the box is
  // the animation's, so a resize then is not a resting width.
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (!swelling.current) settled.current = widthOf(el); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [slot]);

  useLayoutEffect(() => () => running.current.forEach((a) => a.cancel()), []);
}
