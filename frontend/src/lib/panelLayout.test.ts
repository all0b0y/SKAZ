import { describe, expect, it } from 'vitest';
import {
  CENTER_MIN, COLLAPSE_OVERSHOOT, PANEL_DEFAULT, PANEL_MIN, STORAGE_KEY,
  defaultPrefs, dragPanel, fitPanels, isShown, loadPrefs, maxDragWidth, savePrefs, togglePanel,
  type PanelPrefs,
} from './panelLayout';

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
    data,
  };
};

const prefs = (over: Partial<PanelPrefs> = {}): PanelPrefs => ({ ...defaultPrefs(), ...over });

describe('fitPanels', () => {
  it('docks both panels at their remembered width in a wide window', () => {
    const layout = fitPanels(1600, prefs());
    expect(layout.sessions).toEqual({ docked: true, overlay: false, width: PANEL_DEFAULT.sessions });
    expect(layout.assistant).toEqual({ docked: true, overlay: false, width: PANEL_DEFAULT.assistant });
  });

  it('shrinks panels toward their minimum before closing anything, keeping the centre minimum', () => {
    const width = CENTER_MIN + PANEL_MIN.sessions + PANEL_MIN.assistant + 40;
    const layout = fitPanels(width, prefs());
    expect(layout.sessions.docked && layout.assistant.docked).toBe(true);
    expect(layout.sessions.width + layout.assistant.width).toBeLessThanOrEqual(width - CENTER_MIN);
    expect(layout.sessions.width).toBeGreaterThanOrEqual(PANEL_MIN.sessions);
    expect(layout.assistant.width).toBeGreaterThanOrEqual(PANEL_MIN.assistant);
  });

  it('closes the assistant first, then the sessions, without touching the remembered choice', () => {
    const remembered = prefs();
    const one = fitPanels(CENTER_MIN + PANEL_MIN.sessions + PANEL_MIN.assistant - 1, remembered);
    expect(one.assistant.docked).toBe(false);
    expect(one.sessions.docked).toBe(true);
    const none = fitPanels(CENTER_MIN + PANEL_MIN.sessions - 1, remembered);
    expect(none.sessions.docked || none.assistant.docked).toBe(false);
    expect(remembered).toEqual(defaultPrefs());
    // Widening again brings both back at their remembered widths.
    expect(fitPanels(1600, remembered).assistant).toEqual(
      { docked: true, overlay: false, width: PANEL_DEFAULT.assistant });
  });

  it('keeps a closed panel closed however wide the window is', () => {
    const layout = fitPanels(2400, prefs({ assistant: { open: false, width: 400 } }));
    expect(isShown(layout.assistant)).toBe(false);
    expect(layout.sessions.docked).toBe(true);
  });
});

describe('togglePanel', () => {
  it('closes a shown panel and remembers it closed', () => {
    const result = togglePanel('assistant', 1600, prefs(), null);
    expect(result.prefs.assistant.open).toBe(false);
    expect(result.overlay).toBeNull();
  });

  it('floats a panel the user explicitly opens in a window too narrow to dock it', () => {
    const narrow = CENTER_MIN + PANEL_MIN.sessions + 100;
    expect(isShown(fitPanels(narrow, prefs()).assistant)).toBe(false);
    const result = togglePanel('assistant', narrow, prefs(), null);
    expect(result.overlay).toBe('assistant');
    const layout = fitPanels(narrow, result.prefs, result.overlay);
    expect(layout.assistant.overlay).toBe(true);
    expect(layout.assistant.width).toBeLessThan(narrow);
    // Closing the floating panel really closes it.
    const closed = togglePanel('assistant', narrow, result.prefs, result.overlay);
    expect(closed.overlay).toBeNull();
    expect(isShown(fitPanels(narrow, closed.prefs, closed.overlay).assistant)).toBe(false);
  });

  it('docks rather than floats when the reopened panel fits', () => {
    const result = togglePanel('sessions', 1600, prefs({ sessions: { open: false, width: 240 } }), null);
    expect(result.overlay).toBeNull();
    expect(fitPanels(1600, result.prefs).sessions).toEqual({ docked: true, overlay: false, width: 240 });
  });
});

describe('dragPanel', () => {
  it('follows the pointer between the minimum and the allowed maximum', () => {
    expect(dragPanel('sessions', 250, 30, 500)).toEqual({ open: true, width: 280 });
    expect(dragPanel('sessions', 250, 400, 500)).toEqual({ open: true, width: 500 });
    expect(dragPanel('sessions', 250, -70, 500)).toEqual({ open: true, width: PANEL_MIN.sessions });
  });

  it('collapses only once dragged past the minimum by the overshoot', () => {
    const atEdge = PANEL_MIN.assistant - COLLAPSE_OVERSHOOT - 360;
    expect(dragPanel('assistant', 360, atEdge, 700)).toEqual({ open: true, width: PANEL_MIN.assistant });
    expect(dragPanel('assistant', 360, atEdge - 1, 700)).toEqual({ open: false });
  });

  it('never lets a drag squeeze the centre below its minimum', () => {
    const layout = fitPanels(1200, prefs());
    const max = maxDragWidth('sessions', 1200, layout);
    expect(max).toBe(1200 - CENTER_MIN - layout.assistant.width);
  });
});

describe('persistence', () => {
  it('round-trips widths and open state', () => {
    const storage = memory();
    const saved = prefs({ sessions: { open: false, width: 300 } });
    savePrefs(saved, storage);
    expect(loadPrefs(storage)).toEqual(saved);
  });

  it('falls back per field on malformed data instead of resetting everything', () => {
    const storage = memory({ [STORAGE_KEY]: JSON.stringify({
      sessions: { open: false, width: 'wide' }, assistant: { open: 'yes', width: 99_999 },
    }) });
    const loaded = loadPrefs(storage);
    expect(loaded.sessions).toEqual({ open: false, width: PANEL_DEFAULT.sessions });
    expect(loaded.assistant.open).toBe(true);
    expect(loaded.assistant.width).toBeLessThan(99_999);
    expect(loadPrefs(memory({ [STORAGE_KEY]: '{not json' }))).toEqual(defaultPrefs());
  });
});
