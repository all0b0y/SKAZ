import { useEffect, useRef, useState, type CSSProperties, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';
import { Icon } from './Icon';
import { EXIT, SPRING_SMALL } from './motion';
import { useMotionLevel } from './motionLevel';
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

/** How long a toast lives (pointer and focus outside it). */
export const TOAST_SHOW_MS = 6000;
const COUNTDOWN_TICK_MS = 250;

/**
 * A short line about what just happened, at the bottom of the window, with at most one action
 * (Undo). It closes by itself; hovering or focusing it holds it, and the time it had left resumes.
 *
 * Toast fuse (stage 6, B4): a toast with an action shows the time left to act — a 2 px line that
 * runs down over the toast's life (full and calm: it is a status) or, at motion «off», a «· N s»
 * countdown in text. One source of truth: the timer below; the line pauses with it (`is-held`) and,
 * whenever it mounts (a new toast, or motion turned back on mid-toast), starts at the time already
 * gone (`animation-delay: -elapsed`), so the line and the timer never drift apart (FIX2 S-L1).
 */
export function Toast({ toast, onClose }: { toast: ToastData | null; onClose: () => void }) {
  const level = useMotionLevel();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const timer = useRef<number | undefined>(undefined);
  /** Time left while held; while running, time left at `since`. */
  const left = useRef(TOAST_SHOW_MS);
  const since = useRef(0);
  const holds = useRef({ pointer: false, focus: false });
  const heldRef = useRef(false);
  const [held, setHeld] = useState(false);
  const [, setTick] = useState(0);
  /** The toast the timer runs for (until its effect has run, a new toast has its whole life left). */
  const runningFor = useRef<number | null>(null);

  const run = () => {
    window.clearTimeout(timer.current);
    since.current = Date.now();
    timer.current = window.setTimeout(() => onCloseRef.current(), Math.max(0, left.current));
  };
  const pause = () => {
    window.clearTimeout(timer.current);
    left.current -= Date.now() - since.current;
  };
  const sync = () => {
    const now = holds.current.pointer || holds.current.focus;
    if (now === heldRef.current) return;
    heldRef.current = now;
    setHeld(now);
    if (now) pause(); else run();
  };
  const remaining = () => {
    if (runningFor.current !== toast?.id) return TOAST_SHOW_MS;
    return heldRef.current ? left.current : left.current - (Date.now() - since.current);
  };

  useEffect(() => {
    // No toast: the one that is fading out owns no timer any more (its handlers go quiet, FIX2 C-L1).
    if (!toast) { runningFor.current = null; return undefined; }
    left.current = TOAST_SHOW_MS;
    holds.current = { pointer: false, focus: false };
    heldRef.current = false;
    setHeld(false);
    runningFor.current = toast.id;
    run();
    return () => window.clearTimeout(timer.current);
  }, [toast?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const countdown = level === 'off' && Boolean(toast?.action);
  useEffect(() => {
    if (!countdown || held) return undefined;
    const iv = window.setInterval(() => setTick((n) => n + 1), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(iv);
  }, [countdown, held, toast?.id]);

  /** The exiting toast (AnimatePresence keeps it while it fades) keeps its old handlers on the same
   *  refs: they must not hold the next toast's clock nor re-arm a timer (FIX2 C-L1). */
  const live = (id: number) => runningFor.current === id;
  const hold = (id: number, what: 'pointer' | 'focus', on: boolean) => {
    if (!live(id)) return;
    holds.current[what] = on;
    sync();
  };
  const onBlur = (id: number, event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    hold(id, 'focus', false);
  };

  return createPortal(
    <AnimatePresence>
      {toast && (
        <m.div key={toast.id} role="status" aria-live="polite"
          className={`kb-toast${toast.tone === 'problem' ? ' kb-toast--problem' : ''}${held ? ' is-held' : ''}`}
          data-testid="toast"
          onMouseEnter={() => hold(toast.id, 'pointer', true)}
          onMouseLeave={() => hold(toast.id, 'pointer', false)}
          onFocus={() => hold(toast.id, 'focus', true)} onBlur={(event) => onBlur(toast.id, event)}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: SPRING_SMALL }} exit={{ opacity: 0, transition: EXIT }}>
          {/* A quiet shimmer left of the toast, once per toast (a new id remounts it); only for good news
              (tone 'done') — never a problem, nor a neutral note («Already pinned»). */}
          {toast.tone === 'done' && <ToastStipple />}
          <Icon name={toast.tone === 'problem' ? 'warning' : 'check'} size={14} />
          <span className="kb-toast__text">{toast.text}</span>
          {/* Off: the time left in text; hidden from the live region so it is not read every second. */}
          {countdown && (
            <span className="kb-toast__countdown" aria-hidden="true">· {Math.max(0, Math.ceil(remaining() / 1000))} s</span>
          )}
          {toast.action && (
            <button type="button" className="kb-toast__action" onClick={() => { const run = toast.action!.run; onCloseRef.current(); run(); }}>
              {toast.action.label}
            </button>
          )}
          <button type="button" className="kb-toast__close" aria-label="Dismiss" onClick={() => onCloseRef.current()}>
            <Icon name="close" size={12} />
          </button>
          {toast.action && !countdown && <Fuse elapsed={TOAST_SHOW_MS - remaining()} />}
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** The fuse line. `elapsed` is read once, when it mounts: later renders must not re-time the running
 *  CSS animation (changing the delay of a running animation would jump it). */
function Fuse({ elapsed }: { elapsed: number }) {
  const [delay] = useState(() => Math.max(0, Math.min(TOAST_SHOW_MS, Math.round(elapsed))));
  return (
    <i className="kb-toast__fuse" aria-hidden="true"
      style={{ '--kb-toast-life': `${TOAST_SHOW_MS}ms`, animationDelay: `${-delay}ms` } as CSSProperties} />
  );
}
