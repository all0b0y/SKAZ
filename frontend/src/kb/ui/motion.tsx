import type { ReactNode } from 'react';
import { LazyMotion, MotionConfig, domMax } from 'motion/react';
import type { Transition } from 'motion/react';
import { useMotionLevel } from './motionLevel';

/**
 * Motion rules (decision 36): calm springs without bounce, exits shorter than entries,
 * reduced motion honoured: at «calm» or «off» (the Appearance knob or the system setting, see
 * motionLevel) motion drops transforms/layout and keeps opacity; «off» also stops CSS transitions.
 * Nothing waits for an animation to end; streaming text is never animated.
 */
export const SPRING_SMALL: Transition = { type: 'spring', visualDuration: 0.26, bounce: 0 };
export const SPRING_LARGE: Transition = { type: 'spring', visualDuration: 0.32, bounce: 0 };
export const EXIT: Transition = { duration: 0.18, ease: [0.4, 0, 1, 1] };

export function MotionProvider({ children }: { children: ReactNode }) {
  const level = useMotionLevel();
  // domMax carries layout/layoutId (selected-item indicators); still lazy, `m` stays small.
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion={level === 'full' ? 'user' : 'always'} transition={level === 'off' ? { duration: 0 } : SPRING_SMALL}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
