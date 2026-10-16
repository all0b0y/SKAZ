import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { paneRectOf, placePopup, POPUP_MARGIN } from '../lib/paneBounds';

type Anchor = { x: number; y: number } | DOMRect | { left: number; top: number; right: number; bottom: number };

/** The stylesheet's own cap on an axis (`max-width: 320px`), or Infinity for `none`. */
function cssCap(el: HTMLElement, prop: 'maxWidth' | 'maxHeight'): number {
  el.style[prop] = '';
  const value = parseFloat(getComputedStyle(el)[prop]);
  return Number.isFinite(value) ? value : Infinity;
}

/**
 * Positions a `position: fixed` popup inside the column it belongs to
 * (.dev/docs/PANES-SPEC.md §1): it flips at the column edge, and when the column
 * is narrower or shorter than the popup, it is capped to the column so it wraps
 * and scrolls instead of spilling over the neighbouring column.
 *
 * Writes straight to the element's style in a layout effect, so the first paint
 * is already in place, and re-places when the popup's size or the window changes.
 *
 * `getAnchor` is read at layout time: a pointer position, or a trigger's rect.
 * `boundsFrom` is an element inside the owning column — the popup itself is
 * portalled to <body> and so has no column of its own.
 */
export function usePanePlacement(
  ref: RefObject<HTMLElement | null>,
  getAnchor: () => Anchor | null,
  options: { align?: 'start' | 'end'; boundsFrom?: RefObject<Element | null> } = {},
  deps: unknown[] = [],
) {
  const { align = 'start', boundsFrom } = options;
  const place = () => {
    const el = ref.current;
    const anchor = getAnchor();
    if (!el || !anchor) return;
    const room = paneRectOf(boundsFrom?.current ?? el);
    const capW = Math.max(0, room.right - room.left - 2 * POPUP_MARGIN);
    const capH = Math.max(0, room.bottom - room.top - 2 * POPUP_MARGIN);
    // Cap first, then measure: a capped popup wraps and changes height.
    el.style.maxWidth = `${Math.min(cssCap(el, 'maxWidth'), capW)}px`;
    el.style.maxHeight = `${Math.min(cssCap(el, 'maxHeight'), capH)}px`;
    el.style.minWidth = '';
    const minWidth = parseFloat(getComputedStyle(el).minWidth) || 0;
    if (minWidth > capW) el.style.minWidth = `${capW}px`;
    const box = el.getBoundingClientRect();
    const at = placePopup({
      // A DOMRect also has x/y, so tell a rect from a point by its far edge.
      anchor: 'right' in anchor
        ? { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom }
        : { x: anchor.x, y: anchor.y },
      size: { width: box.width, height: box.height },
      bounds: room,
      align,
    });
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  useLayoutEffect(() => {
    place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [align, ...deps]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onResize = () => placeRef.current();
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver === 'undefined') return () => window.removeEventListener('resize', onResize);
    // Only a real size change re-places: writing left/top does not resize.
    let last = '';
    const observer = new ResizeObserver(([entry]) => {
      const size = entry ? `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}` : '';
      if (size === last) return;
      last = size;
      placeRef.current();
    });
    observer.observe(el);
    return () => {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
