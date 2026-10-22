import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';
import { Icon } from './Icon';
import { EXIT, SPRING_SMALL } from './motion';
import { ToastStipple } from '../fx/stipple';

export interface ToastData {
  /** A new id restarts the timer even with the same text. */
  id: number;
  text: string;
  /** 'done' = good news (check icon + the arrival shimmer); 'problem' = warning; none = a neutral note. */
  tone?: 'done' | 'problem';
  /** One action (Undo); it closes the toast. */
  action?: { label: string; run: () => void };
}

const SHOW_MS = 6000;

/**
 * A short line about what just happened, at the bottom of the window, with at most one action
 * (Undo). It closes by itself; hovering or focusing it holds it.
 */
export function Toast({ toast, onClose }: { toast: ToastData | null; onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const timer = useRef<number | undefined>(undefined);
  const arm = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCloseRef.current(), SHOW_MS);
  };
  useEffect(() => {
    if (!toast) return undefined;
    arm();
    return () => window.clearTimeout(timer.current);
  }, [toast?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <AnimatePresence>
      {toast && (
        <m.div key={toast.id} role="status" aria-live="polite" className={`kb-toast${toast.tone === 'problem' ? ' kb-toast--problem' : ''}`}
          data-testid="toast"
          onMouseEnter={() => window.clearTimeout(timer.current)} onMouseLeave={arm}
          onFocus={() => window.clearTimeout(timer.current)} onBlur={arm}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: SPRING_SMALL }} exit={{ opacity: 0, transition: EXIT }}>
          {/* A quiet shimmer left of the toast, once per toast (a new id remounts it); only for good news
              (tone 'done') — never a problem, nor a neutral note («Already pinned»). */}
          {toast.tone === 'done' && <ToastStipple />}
          <Icon name={toast.tone === 'problem' ? 'warning' : 'check'} size={14} />
          <span className="kb-toast__text">{toast.text}</span>
          {toast.action && (
            <button type="button" className="kb-toast__action" onClick={() => { const run = toast.action!.run; onCloseRef.current(); run(); }}>
              {toast.action.label}
            </button>
          )}
          <button type="button" className="kb-toast__close" aria-label="Dismiss" onClick={() => onCloseRef.current()}>
            <Icon name="close" size={12} />
          </button>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
