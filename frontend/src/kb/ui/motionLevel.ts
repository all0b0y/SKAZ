import { useSyncExternalStore } from 'react';
import { useReducedMotion as useSystemReducedMotion } from 'motion/react';

/**
 * The one motion switch of the renderer (DESIGN-SYSTEM.md, decision 15): the Appearance knob
 * (`html[data-motion]` = full | calm | off, written by KbApp) combined with the system's
 * reduced-motion. The system wins: with it on, the app is at most «calm». The knob only takes
 * motion away. Read from <html>, not from a store, so any component (and any test) can use it.
 */

export type MotionLevel = 'full' | 'calm' | 'off';

function readKnob(): MotionLevel {
  if (typeof document === 'undefined') return 'full';
  const v = document.documentElement.dataset.motion;
  return v === 'calm' || v === 'off' ? v : 'full';
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  return () => obs.disconnect();
}

export function effectiveMotion(knob: MotionLevel, systemReduced: boolean): MotionLevel {
  if (knob === 'off') return 'off';
  return systemReduced || knob === 'calm' ? 'calm' : 'full';
}

export function useMotionLevel(): MotionLevel {
  const knob = useSyncExternalStore(subscribe, readKnob, () => 'full' as const);
  const system = useSystemReducedMotion() ?? false;
  return effectiveMotion(knob, system);
}

/** Decorative and spatial motion (fields, entrances, animated icons, card flips): only at «full». */
export function useReducedMotion(): boolean {
  return useMotionLevel() !== 'full';
}

/**
 * Status indicators (thinking, work in progress) keep moving at «calm» — they are status, not
 * decoration — but are a still frame when the knob is off or the system asks for reduced motion.
 */
export function useStillIndicators(): boolean {
  const knob = useSyncExternalStore(subscribe, readKnob, () => 'full' as const);
  const system = useSystemReducedMotion() ?? false;
  return knob === 'off' || system;
}
