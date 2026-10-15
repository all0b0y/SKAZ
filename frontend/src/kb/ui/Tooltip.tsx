import {
  cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type FocusEvent, type MouseEvent, type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { boundaryFor, placePopup, type Placement } from './geometry';

const OPEN_DELAY_MS = 450;

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

/** Hover/focus hint. Shows after a short delay, hides on leave/blur/Escape. */
export function Tooltip({ text, children, placement = 'bottom', describes = false }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((target: HTMLElement, immediate: boolean) => {
    anchorRef.current = target;
    window.clearTimeout(timer.current);
    if (immediate) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
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
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
