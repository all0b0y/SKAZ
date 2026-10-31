import { RIGHT_MAX, RIGHT_MIN, SIDE_MAX, SIDE_MIN } from '../state/prefs';

export const RAIL_W = 52;
export const CENTER_MIN = 340;
/**
 * The gap around the inset sheets (DESIGN-SYSTEM.md decision 24 «Windows»): right of and below the
 * window's last sheet, between the side panel and the centre, between the centre and the document
 * panel. The column resizers live in it. Same value as `--kb-gutter` in tokens.css.
 */
export const GUTTER = 8;

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

/** Room for the columns: the window minus the rail and the gutter at the window's right edge. */
function room(windowWidth: number): number {
  return Math.max(0, windowWidth - RAIL_W - GUTTER);
}

/**
 * Column widths that always fit the window: stored widths are preferences, shrunk (never below
 * their minimum) when the window is narrow, the side panel hides last. Every column after the rail
 * is separated by a gutter: rail · side · gutter · centre · gutter · document · gutter.
 * Stored values are untouched.
 */
export function computeLayout(input: LayoutInput): LayoutOutput {
  const available = room(input.windowWidth);
  const centerVisible = !(input.docOpen && input.docExpanded);
  if (!centerVisible) {
    // The expanded document is the centre sheet: it keeps the centre's minimum.
    const side = input.sideOpen && available - SIDE_MIN - GUTTER >= CENTER_MIN
      ? Math.min(input.sideWidth, available - GUTTER - CENTER_MIN) : 0;
    return { side, right: null, centerVisible };
  }
  let right: number | null = null;
  if (input.docOpen) {
    const reserveSide = input.sideOpen ? SIDE_MIN + GUTTER : 0;
    right = Math.min(input.rightWidth, Math.max(RIGHT_MIN, available - CENTER_MIN - GUTTER - reserveSide));
  }
  let side = 0;
  if (input.sideOpen) {
    const left = available - CENTER_MIN - (right === null ? 0 : right + GUTTER) - GUTTER;
    side = left >= SIDE_MIN ? Math.min(input.sideWidth, left) : 0;
  }
  return { side, right, centerVisible };
}

/** Width the shell takes for a layout: rail, columns and gutters (the centre at its minimum). */
export function usedWidth(layout: LayoutOutput): number {
  const side = layout.side > 0 ? layout.side + GUTTER : 0;
  const right = layout.right === null ? 0 : layout.right + GUTTER;
  return RAIL_W + side + CENTER_MIN + right + GUTTER;
}

/** How far each resizer may go so the centre keeps its minimum (gutters included). */
export function resizeLimits(windowWidth: number, layout: LayoutOutput): { sideMax: number; rightMax: number } {
  const available = room(windowWidth);
  const rightUsed = layout.right === null ? 0 : layout.right + GUTTER;
  const sideUsed = layout.side > 0 ? layout.side + GUTTER : 0;
  return {
    sideMax: Math.max(SIDE_MIN, Math.min(SIDE_MAX, available - CENTER_MIN - rightUsed - GUTTER)),
    rightMax: Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, available - CENTER_MIN - sideUsed - GUTTER)),
  };
}
