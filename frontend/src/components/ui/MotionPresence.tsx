import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';

const PresenceActive = createContext(true);
export const usePresenceActive = (): boolean => useContext(PresenceActive);
const EXIT_MS = 140;

/** Keep only the visual exit, never its interactions or modal focus trap.
 * Rapid reopening cancels the exit without replacing the child's draft. */
export function MotionPresence({ open, children }: { open: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const [present, setPresent] = useState(open);
  const lastChildren = useRef(children);
  if (open) lastChildren.current = children;
  useLayoutEffect(() => {
    if (open) { setPresent(true); return; }
    if (reduced) { setPresent(false); return; }
    const timer = window.setTimeout(() => setPresent(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, reduced]);
  if (!open && (!present || reduced)) return null;
  return <PresenceActive.Provider value={open}>
    <div className="motion-presence" data-state={open ? 'enter' : 'exit'}
      aria-hidden={!open || undefined} {...(!open ? { inert: '' } : {})}>
      {open ? children : lastChildren.current}
    </div>
  </PresenceActive.Provider>;
}
