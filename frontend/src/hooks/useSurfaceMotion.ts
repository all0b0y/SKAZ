import { useLayoutEffect, type RefObject } from 'react';
import { useReducedMotion } from './useReducedMotion';

/** Animate a structural navigation identity, never a streamed text revision.
 * The real DOM stays mounted: selection, scroll and drafts are not reset. */
export function useSurfaceMotion(ref: RefObject<HTMLElement | null>, identity: string, enabled = true): void {
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || reduced || !enabled || !element.animate) return;
    const animation = element.animate([
      { opacity: 0.65, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    return () => animation.cancel();
  }, [ref, identity, enabled, reduced]);
}
