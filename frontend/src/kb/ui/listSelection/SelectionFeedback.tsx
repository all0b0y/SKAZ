import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';
import { useMotionLevel, useStillIndicators } from '../motionLevel';
import { HOLD_MS, type PointerFeedback } from './pointerSelection';

/** Gesture feedback only; the timer/selected ids, never an animation, decide the outcome. */
export function SelectionFeedback({ feedback }: { feedback: PointerFeedback | null }) {
  const level = useMotionLevel();
  const still = useStillIndicators();
  const pulse = useRef<Animation | null>(null);
  useEffect(() => {
    if (level !== 'full' || still) { pulse.current?.cancel(); pulse.current = null; return; }
    if (feedback?.kind !== 'hold' || feedback.phase !== 'held') return;
    pulse.current?.cancel();
    const animation = feedback.row.animate?.([{ transform: 'scale(1.025)' }, { transform: 'none' }],
      { duration: 260, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    pulse.current = animation ?? null;
    const release = () => { if (pulse.current === animation) pulse.current = null; };
    void animation?.finished.then(release, release);
  }, [feedback, level, still]);
  useEffect(() => () => { pulse.current?.cancel(); }, []);
  if (typeof document === 'undefined') return null;
  const hold = feedback?.kind === 'hold' ? feedback : null;
  const ring = (done: boolean) => (
    <svg viewBox="0 0 34 34" width="34" height="34" aria-hidden="true">
      <circle className="kb-selection-hold__bg" cx="17" cy="17" r="13" />
      <circle className="kb-selection-hold__fg" cx="17" cy="17" r="13" strokeDasharray="81.7"
        strokeDashoffset={done ? 0 : 81.7} style={{ animationDuration: `${HOLD_MS}ms` }} />
    </svg>
  );
  return createPortal(<>
    {hold?.phase === 'pending' && (
      <div className="kb-selection-hold" data-phase="pending" data-motion={still ? 'off' : level} aria-hidden="true"
        style={{ left: hold.x, top: hold.y, animationDuration: `${HOLD_MS}ms` }}>{ring(false)}</div>
    )}
    <AnimatePresence>
      {hold?.phase === 'held' && (
        <m.div key={hold.id} className="kb-selection-hold" data-phase="held" aria-hidden="true"
          style={{ left: hold.x, top: hold.y }} initial={{ opacity: 1 }} animate={{ opacity: 0 }}
          transition={{ delay: still ? 0 : 0.12, duration: still ? 0 : 0.22 }}
          exit={{ opacity: 0, transition: { duration: still ? 0 : 0.22 } }}>{ring(true)}</m.div>
      )}
    </AnimatePresence>
    {feedback?.kind === 'band' && <div className="kb-selection-band" aria-hidden="true"
      style={{ left: feedback.x, top: feedback.y, width: feedback.width, height: feedback.height }} />}
  </>, document.body);
}
