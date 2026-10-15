import { RIGHT_MIN, SIDE_MIN } from '../state/prefs';

export const RAIL_W = 88;
export const CENTER_MIN = 340;

export interface LayoutInput {
  windowWidth: number;
  sideOpen: boolean;
  sideWidth: number;
  docOpen: boolean;
  docExpanded: boolean;
  rightWidth: number;
}

export interface LayoutOutput {
  /** 0 when the side panel is not shown (closed by the user or no room). */
  side: number;
  /** Width of the document panel; null = it takes the centre (expanded) or is closed. */
  right: number | null;
  centerVisible: boolean;
}

/**
 * Column widths that always fit the window: stored widths are preferences, shrunk (never below
 * their minimum) when the window is narrow, the side panel hides last. Stored values are untouched.
 */
export function computeLayout(input: LayoutInput): LayoutOutput {
  const available = Math.max(0, input.windowWidth - RAIL_W);
  const centerVisible = !(input.docOpen && input.docExpanded);
  if (!centerVisible) {
    const side = input.sideOpen && available - SIDE_MIN >= CENTER_MIN
      ? Math.min(input.sideWidth, available - CENTER_MIN) : 0;
    return { side, right: null, centerVisible };
  }
  let right: number | null = null;
  if (input.docOpen) {
    const reserveSide = input.sideOpen ? SIDE_MIN : 0;
    right = Math.min(input.rightWidth, Math.max(RIGHT_MIN, available - CENTER_MIN - reserveSide));
  }
  let side = 0;
  if (input.sideOpen) {
    const room = available - CENTER_MIN - (right ?? 0);
    side = room >= SIDE_MIN ? Math.min(input.sideWidth, room) : 0;
  }
  return { side, right, centerVisible };
}
