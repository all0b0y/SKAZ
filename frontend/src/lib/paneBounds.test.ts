import { describe, expect, it } from 'vitest';
import { placePopup, POPUP_MARGIN, type Rect } from './paneBounds';

// The centre column of a 1400px window with both side panels docked.
const centre: Rect = { left: 250, top: 40, right: 1040, bottom: 820 };
const inside = (at: { left: number; top: number }, size: { width: number; height: number }, room: Rect) =>
  at.left >= room.left + POPUP_MARGIN && at.left + size.width <= room.right - POPUP_MARGIN
  && at.top >= room.top + POPUP_MARGIN && at.top + size.height <= room.bottom - POPUP_MARGIN;

describe('placePopup — a popup stays inside its column (PANES-SPEC §1)', () => {
  const menu = { width: 220, height: 160 };

  it('opens right/down from the pointer when there is room', () => {
    const at = placePopup({ anchor: { x: 400, y: 200 }, size: menu, bounds: centre });
    expect(at).toMatchObject({ left: 400, top: 200 });
  });

  it('opens leftwards at the column edge instead of spilling into the next column', () => {
    const at = placePopup({ anchor: { x: 1020, y: 200 }, size: menu, bounds: centre });
    expect(at.left).toBe(1020 - menu.width);
    expect(inside(at, menu, centre)).toBe(true);
  });

  it('opens upwards near the column bottom', () => {
    const at = placePopup({ anchor: { x: 400, y: 800 }, size: menu, bounds: centre });
    expect(at.top).toBe(800 - menu.height);
  });

  it('clamps inside when neither direction fits', () => {
    const narrow: Rect = { left: 0, top: 0, right: 300, bottom: 820 };
    const at = placePopup({ anchor: { x: 150, y: 100 }, size: menu, bounds: narrow });
    expect(inside(at, menu, narrow)).toBe(true);
  });

  it('caps a popup wider than its column to the column', () => {
    const rail: Rect = { left: 0, top: 40, right: 200, bottom: 820 };
    const at = placePopup({ anchor: { x: 100, y: 100 }, size: { width: 260, height: 100 }, bounds: rail });
    expect(at.maxWidth).toBe(200 - 2 * POPUP_MARGIN);
    expect(at.left).toBe(POPUP_MARGIN);
  });

  it('hangs a dropdown below its trigger, end-aligned, and above it when the bottom is full', () => {
    const trigger: Rect = { left: 1000, top: 60, right: 1026, bottom: 86 };
    const below = placePopup({ anchor: trigger, size: { width: 260, height: 200 }, bounds: centre, align: 'end' });
    expect(below.left + 260).toBe(1026);
    expect(below.top).toBeGreaterThan(86);
    const low: Rect = { left: 1000, top: 760, right: 1026, bottom: 786 };
    const above = placePopup({ anchor: low, size: { width: 260, height: 200 }, bounds: centre, align: 'end' });
    expect(above.top + 200).toBeLessThan(760);
  });

  it('flips a start-aligned dropdown to end-aligned at the right edge', () => {
    const trigger: Rect = { left: 950, top: 60, right: 1030, bottom: 86 };
    const at = placePopup({ anchor: trigger, size: { width: 320, height: 200 }, bounds: centre });
    expect(at.left + 320).toBe(1030);
  });
});
