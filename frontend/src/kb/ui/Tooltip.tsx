import {
  cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type FocusEvent, type MouseEvent, type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { boundaryFor, placePopup, type Placement } from './geometry';
import { useMotionLevel } from './motionLevel';

/** WarmTooltip (stage 6, B5, the motion6 demo): the first tooltip of a row waits this long… */
export const TOOLTIP_WAIT_MS = 500;
/** …and after a tooltip closes the row stays «warm» this long: the next one opens at once. */
export const TOOLTIP_WARM_MS = 800;

/**
 * One warm state for the whole window, shared by every Tooltip: warm while ANY tooltip is open and
 * for TOOLTIP_WARM_MS after the last one closed — it counts the open ones, so one closing while
 * another (say, a keyboard-focused one) stays open does not cool the row (FIX2 C-L2). The timing
 * rule holds at every motion level; only the entrance changes (full: rise, calm: fade, off: none —
 * and none while warm). Each Tooltip calls heat() once when it opens and cool() once when it closes.
 */
const warmth = { warm: false, open: 0, cool: undefined as number | undefined };
function heat() {
  window.clearTimeout(warmth.cool);
  warmth.cool = undefined;
  warmth.open += 1;
  warmth.warm = true;
}
function cool() {
  warmth.open = Math.max(0, warmth.open - 1);
  if (warmth.open > 0 || !warmth.warm) return;
  window.clearTimeout(warmth.cool);
  warmth.cool = window.setTimeout(() => { warmth.warm = false; warmth.cool = undefined; }, TOOLTIP_WARM_MS);
}
/** Back to cold (tests start each case cold). */
export function resetTooltipWarmth() {
  window.clearTimeout(warmth.cool);
  warmth.warm = false;
  warmth.open = 0;
  warmth.cool = undefined;
}

type Entrance = 'rise' | 'fade' | 'none';

type TriggerProps = {
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  'aria-describedby'?: string;
};

export interface TooltipProps {
  text: string;
  children: ReactElement<TriggerProps>;
  placement?: Placement;
  /**
   * When the trigger's accessible name already is `text` (icon buttons), the tooltip is
   * visual only and not wired as a description, so screen readers do not hear it twice.
   */
  describes?: boolean;
}

/**
 * Hover/focus hint. Cold: shows after TOOLTIP_WAIT_MS with a short entrance. Warm (another tooltip
 * is open or closed < TOOLTIP_WARM_MS ago): shows at once, no entrance. Keyboard focus shows it at
 * once. Hides on leave/blur/Escape.
 */
export function Tooltip({ text, children, placement = 'bottom', describes = false }: TooltipProps) {
  const id = useId();
  const level = useMotionLevel();
  const levelRef = useRef(level);
  levelRef.current = level;
  const [entrance, setEntrance] = useState<Entrance | null>(null); // null = closed
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const openRef = useRef(false);
  const open = entrance !== null;

  const reveal = useCallback((how: Entrance) => {
    if (!openRef.current) heat(); // shown again while open (hover, then focus): counted once
    openRef.current = true;
    setEntrance(how);
  }, []);
  const show = useCallback((target: HTMLElement, immediate: boolean) => {
    anchorRef.current = target;
    window.clearTimeout(timer.current);
    const cold = (): Entrance => (levelRef.current === 'full' ? 'rise' : levelRef.current === 'calm' ? 'fade' : 'none');
    if (warmth.warm) reveal('none');
    else if (immediate) reveal(cold());
    else timer.current = window.setTimeout(() => reveal(cold()), TOOLTIP_WAIT_MS);
  }, [reveal]);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    if (openRef.current) cool();
    openRef.current = false;
    setEntrance(null);
    setPos(null);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (openRef.current) cool();
    openRef.current = false;
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    setPos(placePopup(a, { width: t.width, height: t.height }, placement, boundaryFor(anchorRef.current, { placement, scope: 'window' })));
  }, [open, placement, text]);

  const child = children;
  const props: TriggerProps = {
    onMouseEnter: (event) => { child.props.onMouseEnter?.(event); show(event.currentTarget, false); },
    onMouseLeave: (event) => { child.props.onMouseLeave?.(event); hide(); },
    onFocus: (event) => {
      child.props.onFocus?.(event);
      if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget, true);
    },
    onBlur: (event) => { child.props.onBlur?.(event); hide(); },
  };
  if (describes && open) props['aria-describedby'] = id;

  return (
    <>
      {cloneElement(child, props)}
      {open && createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className="kb-tooltip"
          data-enter={entrance === 'none' ? undefined : entrance}
          data-side={placement.startsWith('top') ? 'top' : placement === 'right' ? 'right' : 'bottom'}
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
