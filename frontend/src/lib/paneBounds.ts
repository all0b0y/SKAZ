/**
 * Every column of the workspace is a screen of its own (.dev/docs/PANES-SPEC.md):
 * a menu or popover raised inside one never crosses its edges. The column's
 * root carries `data-pane`; anything outside a column (titlebar, modal dialogs)
 * is bounded by the window instead.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Set when the popup is wider/taller than the room it has: it shrinks and wraps instead of spilling. */
  maxWidth: number;
  maxHeight: number;
}

/** Kept clear of the column edge so the last item is never flush against it. */
export const POPUP_MARGIN = 8;
/** Gap between a trigger and the dropdown hanging off it. */
export const POPUP_GAP = 4;

export const viewportRect = (): Rect => ({
  left: 0,
  top: 0,
  right: window.innerWidth,
  bottom: window.innerHeight,
});

const intersect = (a: Rect, b: Rect): Rect => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});

/** The rectangle a popup raised from `owner` must stay inside: its column ∩ the window. */
export function paneRectOf(owner: Element | null | undefined): Rect {
  const view = viewportRect();
  const pane = owner?.closest('[data-pane]');
  if (!pane) return view;
  const box = pane.getBoundingClientRect();
  const clipped = intersect(view, box);
  // A zero-size pane (jsdom, a column mid-collapse) bounds nothing useful.
  if (clipped.right - clipped.left <= 0 || clipped.bottom - clipped.top <= 0) return view;
  return clipped;
}

/**
 * One axis: prefer `preferred`; when it runs past the far edge, use `flipped`
 * (the popup opens the other way); then clamp inside the room. A popup larger
 * than the room is pinned to the near edge and capped to the room's size.
 */
function axis(preferred: number, flipped: number, size: number, min: number, max: number) {
  const room = Math.max(0, max - min);
  const length = Math.min(size, room);
  const fits = (start: number) => start >= min && start + length <= max;
  const start = fits(preferred) ? preferred : fits(flipped) ? flipped : preferred;
  return { start: Math.max(min, Math.min(start, max - length)), cap: room };
}

/**
 * Where a popup of `size` goes inside `bounds`.
 *
 * - A point anchor (a right click) opens right/down from the pointer and flips
 *   left/up at the column edge.
 * - A rect anchor (a trigger button) hangs below it — above when there is no room
 *   below — aligned to the trigger's start (or end) and flipped at the edge.
 */
export function placePopup(options: {
  anchor: { x: number; y: number } | Rect;
  size: { width: number; height: number };
  bounds: Rect;
  align?: 'start' | 'end';
  margin?: number;
}): Placement {
  const { anchor, size, bounds, align = 'start', margin = POPUP_MARGIN } = options;
  const minX = bounds.left + margin;
  const maxX = bounds.right - margin;
  const minY = bounds.top + margin;
  const maxY = bounds.bottom - margin;

  let x: ReturnType<typeof axis>;
  let y: ReturnType<typeof axis>;
  if (!('right' in anchor)) {
    x = axis(anchor.x, anchor.x - size.width, size.width, minX, maxX);
    y = axis(anchor.y, anchor.y - size.height, size.height, minY, maxY);
  } else {
    const startX = anchor.left;
    const endX = anchor.right - size.width;
    x = align === 'start'
      ? axis(startX, endX, size.width, minX, maxX)
      : axis(endX, startX, size.width, minX, maxX);
    y = axis(anchor.bottom + POPUP_GAP, anchor.top - POPUP_GAP - size.height, size.height, minY, maxY);
  }
  return { left: x.start, top: y.start, maxWidth: x.cap, maxHeight: y.cap };
}
