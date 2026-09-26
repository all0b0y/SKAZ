import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  PANEL_DEFAULT, dragPanel, fitPanels, isShown, loadPrefs, maxDragWidth, savePrefs, togglePanel,
  type PanelId, type PanelLayout, type PanelPrefs,
} from '../lib/panelLayout';

export interface PanelControls {
  layout: PanelLayout;
  shown: Record<PanelId, boolean>;
  /** The border being dragged, if any: animation is off, the edge follows the pointer. */
  dragging: PanelId | null;
  toggle: (id: PanelId) => void;
  /**
   * Put a floating panel away without forgetting it is open: the window was only
   * too narrow, so it docks again by itself once the window is wide enough.
   */
  dismissOverlay: () => void;
  startDrag: (id: PanelId, event: ReactPointerEvent<HTMLElement>) => void;
  /** Keyboard resize of a focused border (arrow keys), with the same collapse rule as a drag. */
  nudge: (id: PanelId, delta: number) => void;
  resetWidth: (id: PanelId) => void;
}

const windowWidth = () => (typeof window === 'undefined' ? 1440 : window.innerWidth);

/**
 * Side panels: open/closed and width, remembered across restarts, fitted to
 * the window on every resize (docs/PANELS-AND-NOTES-SOURCE-SPEC.md §4–10).
 * ⌘/ toggles the sessions panel, ⌘. the assistant.
 */
export function usePanelLayout(): PanelControls {
  const [prefs, setPrefs] = useState<PanelPrefs>(() => loadPrefs());
  const [overlay, setOverlay] = useState<PanelId | null>(null);
  const [width, setWidth] = useState(windowWidth);
  const [dragging, setDragging] = useState<PanelId | null>(null);

  const layout = useMemo(() => fitPanels(width, prefs, overlay), [width, prefs, overlay]);
  const current = useRef({ prefs, overlay, width, layout });
  current.current = { prefs, overlay, width, layout };

  useEffect(() => {
    const onResize = () => setWidth(windowWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Written once a drag ends, not on every pointer move.
  useEffect(() => {
    if (!dragging) savePrefs(prefs);
  }, [prefs, dragging]);

  // A floating panel exists only because the window is narrow; once it can
  // dock, it simply docks.
  useEffect(() => {
    if (overlay && fitPanels(width, prefs, null)[overlay].docked) setOverlay(null);
  }, [overlay, width, prefs]);

  const toggle = useCallback((id: PanelId) => {
    const { prefs: now, overlay: floating, width: w } = current.current;
    const next = togglePanel(id, w, now, floating);
    setPrefs(next.prefs);
    setOverlay(next.overlay);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      const id: PanelId | null = event.key === '/' ? 'sessions' : event.key === '.' ? 'assistant' : null;
      if (!id) return;
      event.preventDefault();
      toggle(id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  const apply = useCallback((id: PanelId, startWidth: number, delta: number, maxWidth: number) => {
    const outcome = dragPanel(id, startWidth, delta, maxWidth);
    setPrefs((now) => ({
      ...now,
      [id]: outcome.open ? { open: true, width: outcome.width } : { ...now[id], open: false },
    }));
  }, []);

  const startDrag = useCallback((id: PanelId, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const { layout: at, width: w } = current.current;
    const startX = event.clientX;
    const startWidth = at[id].width;
    const maxWidth = maxDragWidth(id, w, at);
    // The left panel grows rightwards, the right one leftwards.
    const direction = id === 'sessions' ? 1 : -1;
    setDragging(id);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('is-resizing-panels');
      setDragging(null);
    };
    const onMove = (move: PointerEvent) => {
      // No primary button held: the release happened where we could not see it
      // (outside the window). Following this pointer would glue the border to
      // a cursor the user is no longer dragging with.
      if ((move.buttons & 1) === 0) {
        onUp();
        return;
      }
      apply(id, startWidth, (move.clientX - startX) * direction, maxWidth);
    };
    document.body.classList.add('is-resizing-panels');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [apply]);

  const nudge = useCallback((id: PanelId, delta: number) => {
    const { layout: at, width: w } = current.current;
    apply(id, at[id].width, delta, maxDragWidth(id, w, at));
  }, [apply]);

  const resetWidth = useCallback((id: PanelId) => {
    setPrefs((now) => ({ ...now, [id]: { open: true, width: PANEL_DEFAULT[id] } }));
  }, []);

  const shown = { sessions: isShown(layout.sessions), assistant: isShown(layout.assistant) };
  const dismissOverlay = useCallback(() => setOverlay(null), []);

  return { layout, shown, dragging, toggle, dismissOverlay, startDrag, nudge, resetWidth };
}
