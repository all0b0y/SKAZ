export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right' | 'bottom';

const GAP = 6;
const MARGIN = 8;

/** The box a popup must stay inside: the anchor's column when it has one, else the window. */
export function boundaryFor(anchor: Element): Rect {
  const pane = anchor.closest('[data-pane]');
  const view = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  if (!pane) return view;
  const r = pane.getBoundingClientRect();
  if (r.width < 2) return view;
  return { left: r.left, top: view.top, right: r.right, bottom: view.bottom };
}

/**
 * Place a popup of `size` next to `anchor`, then pull it back inside `bounds`.
 * Pure: unit-testable without layout.
 */
export function placePopup(
  anchor: Rect,
  size: { width: number; height: number },
  placement: Placement,
  bounds: Rect,
): { left: number; top: number } {
  let left: number;
  let top: number;
  switch (placement) {
    case 'bottom-end':
      left = anchor.right - size.width;
      top = anchor.bottom + GAP;
      break;
    case 'top-start':
      left = anchor.left;
      top = anchor.top - GAP - size.height;
      break;
    case 'top-end':
      left = anchor.right - size.width;
      top = anchor.top - GAP - size.height;
      break;
    case 'right':
      left = anchor.right + GAP;
      top = anchor.top + (anchor.bottom - anchor.top - size.height) / 2;
      break;
    case 'bottom':
      left = anchor.left + (anchor.right - anchor.left - size.width) / 2;
      top = anchor.bottom + GAP;
      break;
    case 'bottom-start':
    default:
      left = anchor.left;
      top = anchor.bottom + GAP;
  }
  // Flip vertically when there is no room below.
  if (top + size.height > bounds.bottom - MARGIN && placement.startsWith('bottom')) {
    const above = anchor.top - GAP - size.height;
    if (above >= bounds.top + MARGIN) top = above;
  }
  left = Math.min(Math.max(left, bounds.left + MARGIN), Math.max(bounds.left + MARGIN, bounds.right - MARGIN - size.width));
  top = Math.min(Math.max(top, bounds.top + MARGIN), Math.max(bounds.top + MARGIN, bounds.bottom - MARGIN - size.height));
  return { left: Math.round(left), top: Math.round(top) };
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true',
  );
}
