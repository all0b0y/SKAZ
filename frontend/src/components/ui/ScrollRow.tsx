import { forwardRef, useEffect, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useOverflowEdges, type OverflowEdges } from '../../hooks/useOverflowEdges';

interface Props extends HTMLAttributes<HTMLDivElement> {
  /** Changes whenever the active item changes; that item is then scrolled into view. */
  activeKey?: string | null;
  /** Told when overflow appears/disappears, for controls shown only then (the "⋯" list). */
  onOverflow?: (edges: OverflowEdges) => void;
  children: ReactNode;
}

/** Keeps a little of the neighbour visible past a revealed item, like VS Code. */
const REVEAL_MARGIN = 24;

function revealActive(el: HTMLElement) {
  const selected = el.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!selected) return;
  // The row's direct child holding the selected control is what must be seen.
  let item: HTMLElement = selected;
  while (item.parentElement && item.parentElement !== el) item = item.parentElement;
  const row = el.getBoundingClientRect();
  const box = item.getBoundingClientRect();
  if (box.left < row.left) el.scrollLeft -= row.left - box.left + REVEAL_MARGIN;
  else if (box.right > row.right) el.scrollLeft += box.right - row.right + REVEAL_MARGIN;
}

/**
 * A horizontal row that never widens its column (.dev/docs/PANES-SPEC.md §3–4).
 *
 * Its items shrink first (their own CSS); what still does not fit scrolls, as in
 * VS Code: the vertical mouse wheel scrolls it sideways, a thin scrollbar shows on
 * hover, the active item (the descendant with `aria-selected="true"`) is brought
 * into view whenever `activeKey` changes, and each edge that hides items fades
 * out through a mask. Pinned controls belong OUTSIDE this row.
 */
export const ScrollRow = forwardRef<HTMLDivElement, Props>(function ScrollRow(
  { activeKey, onOverflow, className, children, ...rest }, forwarded,
) {
  const ref = useRef<HTMLDivElement>(null);
  const edges = useOverflowEdges(ref, 'x');
  const onOverflowRef = useRef(onOverflow);
  onOverflowRef.current = onOverflow;

  useEffect(() => { onOverflowRef.current?.(edges); }, [edges]);

  // A mouse wheel only scrolls vertically; a row has nothing to scroll that way,
  // so turn it sideways. Must be a non-passive native listener to take the event.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return; // trackpad: native
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) revealActive(el);
  }, [activeKey]);

  // The row narrowing (window or column resized) must not hide the active item
  // either — VS Code keeps the current tab in view as the editor shrinks.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      revealActive(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const setRef = (node: HTMLDivElement | null) => {
    (ref as { current: HTMLDivElement | null }).current = node;
    if (typeof forwarded === 'function') forwarded(node);
    else if (forwarded) forwarded.current = node;
  };

  return (
    <div ref={setRef} className={clsx('scroll-row', className)} {...rest}>
      {children}
    </div>
  );
});
