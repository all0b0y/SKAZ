import { useEffect, useRef, type ReactNode } from 'react';
import { animate } from 'motion';
import { useMotionLevel } from './motionLevel';

export function FailureFeedback({ attempt, children }: { attempt: unknown; children: ReactNode }) {
  const level = useMotionLevel();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || level !== 'full') return;
    const shake = animate(ref.current, { x: [0, -4, 3, -1, 0] }, { duration: 0.23, ease: 'easeOut' });
    return () => shake.stop();
  }, [level, attempt]);
  return <div ref={ref}>{children}</div>;
}
