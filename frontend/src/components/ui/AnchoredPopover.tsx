import { forwardRef, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { usePanePlacement } from '../../hooks/usePanePlacement';
import { PanePortal } from './PanePortal';

interface Props extends HTMLAttributes<HTMLDivElement> {
  /** The trigger the dropdown hangs off. */
  anchorRef: RefObject<Element>;
  /** Line the dropdown up with the trigger's left edge (start) or right edge (end). */
  align?: 'start' | 'end';
  children: ReactNode;
}

/**
 * A dropdown hanging off a trigger, kept inside the trigger's column
 * (.dev/docs/PANES-SPEC.md §1): below the trigger, above it when there is no room
 * below, flipped at the column edge, and capped to the column when the column is
 * smaller than the dropdown.
 *
 * It is rendered at <body>, so an owner that closes it on an outside press must
 * treat a press inside the dropdown (forward a ref here) as inside.
 */
export const AnchoredPopover = forwardRef<HTMLDivElement, Props>(function AnchoredPopover(
  { anchorRef, align = 'start', children, ...rest }, forwarded,
) {
  const own = useRef<HTMLDivElement | null>(null);
  const marker = useRef<HTMLSpanElement>(null);
  usePanePlacement(own, () => anchorRef.current?.getBoundingClientRect() ?? null, { align, boundsFrom: marker });
  const setRef = (node: HTMLDivElement | null) => {
    own.current = node;
    if (typeof forwarded === 'function') forwarded(node);
    else if (forwarded) forwarded.current = node;
  };
  return (
    <PanePortal markerRef={marker}>
      <div ref={setRef} {...rest}>{children}</div>
    </PanePortal>
  );
});

/** True when an event target sits inside any of the given elements. */
export function isInside(target: EventTarget | null, ...refs: Array<RefObject<Element | null>>) {
  return refs.some((ref) => !!ref.current && ref.current.contains(target as Node));
}
