/**
 * Side-panel geometry: what the user asked for (remembered) versus what fits
 * the window right now (derived). Pure, so every rule of
 * docs/PANELS-AND-NOTES-SOURCE-SPEC.md is testable without a DOM.
 *
 * The remembered choice is never rewritten by a narrow window: auto-closing and
 * shrinking are recomputed from it on every resize, so widening the window
 * brings the panels back exactly as they were.
 */

export type PanelId = 'sessions' | 'assistant';

export interface PanelPref {
  open: boolean;
  width: number;
}

export type PanelPrefs = Record<PanelId, PanelPref>;

export interface PanelView {
  /** Takes a grid column next to the centre. */
  docked: boolean;
  /** Explicitly opened in a window too narrow to dock it: floats over the centre. */
  overlay: boolean;
  width: number;
}

export type PanelLayout = Record<PanelId, PanelView>;

export const PANEL_MIN: Record<PanelId, number> = { sessions: 200, assistant: 280 };
export const PANEL_DEFAULT: Record<PanelId, number> = { sessions: 250, assistant: 360 };
/** Beyond this the panel is not a side panel any more; also bounds a stale saved value. */
export const PANEL_MAX: Record<PanelId, number> = { sessions: 560, assistant: 720 };
export const CENTER_MIN = 360;
/** Dragging this far past the minimum closes the panel instead of stopping at it. */
export const COLLAPSE_OVERSHOOT = 60;
/** An overlay never covers the whole window: some of the centre stays visible. */
const OVERLAY_GUTTER = 48;

/** Auto-close order when the window is too narrow: the assistant goes first. */
const CLOSE_ORDER: PanelId[] = ['assistant', 'sessions'];

export const STORAGE_KEY = 'skaz.panels';

export function defaultPrefs(): PanelPrefs {
  return {
    sessions: { open: true, width: PANEL_DEFAULT.sessions },
    assistant: { open: true, width: PANEL_DEFAULT.assistant },
  };
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

function clampWidth(id: PanelId, width: number): number {
  return clamp(Math.round(width), PANEL_MIN[id], PANEL_MAX[id]);
}

/**
 * Read the remembered layout. Anything malformed falls back per field to the
 * default rather than discarding the whole record: one bad value must not reset
 * a panel the user deliberately closed.
 */
export function loadPrefs(storage: Pick<Storage, 'getItem'> = localStorage): PanelPrefs {
  const fallback = defaultPrefs();
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return fallback;
  }
  if (!raw || typeof raw !== 'object') return fallback;
  const record = raw as Record<string, unknown>;
  const read = (id: PanelId): PanelPref => {
    const item = record[id] as Record<string, unknown> | undefined;
    const open = typeof item?.open === 'boolean' ? item.open : fallback[id].open;
    const width = typeof item?.width === 'number' && Number.isFinite(item.width)
      ? clampWidth(id, item.width) : fallback[id].width;
    return { open, width };
  };
  return { sessions: read('sessions'), assistant: read('assistant') };
}

export function savePrefs(prefs: PanelPrefs, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A full or unavailable storage only loses the memory of the layout.
  }
}

/**
 * What actually shows in a window of `windowWidth`.
 *
 * Open panels that cannot keep their minimum next to a {@link CENTER_MIN}
 * centre are closed, assistant first. Remaining panels shrink toward their
 * minimum in proportion to how far above it they are. `overlay` names a panel
 * the user explicitly opened although it does not fit; it floats instead.
 */
export function fitPanels(windowWidth: number, prefs: PanelPrefs, overlay: PanelId | null = null): PanelLayout {
  const docked: Record<PanelId, boolean> = { sessions: prefs.sessions.open, assistant: prefs.assistant.open };
  const need = () => CENTER_MIN
    + (docked.sessions ? PANEL_MIN.sessions : 0)
    + (docked.assistant ? PANEL_MIN.assistant : 0);
  for (const id of CLOSE_ORDER) {
    if (need() <= windowWidth) break;
    docked[id] = false;
  }

  const width: Record<PanelId, number> = {
    sessions: clampWidth('sessions', prefs.sessions.width),
    assistant: clampWidth('assistant', prefs.assistant.width),
  };
  const ids = (Object.keys(docked) as PanelId[]).filter((id) => docked[id]);
  const overflow = ids.reduce((sum, id) => sum + width[id], 0) - (windowWidth - CENTER_MIN);
  if (overflow > 0) {
    const slack = ids.reduce((sum, id) => sum + (width[id] - PANEL_MIN[id]), 0);
    for (const id of ids) {
      const share = slack > 0 ? (width[id] - PANEL_MIN[id]) / slack : 0;
      width[id] = Math.max(PANEL_MIN[id], Math.floor(width[id] - overflow * share));
    }
  }

  const view = (id: PanelId): PanelView => {
    if (docked[id]) return { docked: true, overlay: false, width: width[id] };
    const floating = overlay === id && prefs[id].open;
    return {
      docked: false,
      overlay: floating,
      width: floating
        ? Math.max(Math.min(width[id], windowWidth - OVERLAY_GUTTER), Math.min(PANEL_MIN[id], windowWidth))
        : width[id],
    };
  };
  return { sessions: view('sessions'), assistant: view('assistant') };
}

export const isShown = (view: PanelView) => view.docked || view.overlay;

/**
 * The widest a docked panel may be dragged: the centre keeps its minimum next
 * to whatever the other panel currently occupies.
 */
export function maxDragWidth(id: PanelId, windowWidth: number, layout: PanelLayout): number {
  const other: PanelId = id === 'sessions' ? 'assistant' : 'sessions';
  const taken = layout[other].docked ? layout[other].width : 0;
  return Math.max(PANEL_MIN[id], Math.min(PANEL_MAX[id], windowWidth - CENTER_MIN - taken));
}

export type DragOutcome = { open: false } | { open: true; width: number };

/**
 * A drag from `startWidth` by `delta` pixels toward the centre (positive = wider).
 * Past the minimum by {@link COLLAPSE_OVERSHOOT} the panel closes; dragging
 * back inside reopens it at the minimum.
 */
export function dragPanel(id: PanelId, startWidth: number, delta: number, maxWidth: number): DragOutcome {
  const raw = startWidth + delta;
  if (raw < PANEL_MIN[id] - COLLAPSE_OVERSHOOT) return { open: false };
  return { open: true, width: clamp(Math.round(raw), PANEL_MIN[id], Math.max(PANEL_MIN[id], maxWidth)) };
}

/**
 * Toggle what the user sees. A shown panel closes (and is remembered closed);
 * a hidden one is remembered open, and if the window still cannot dock it, it
 * floats — the button must never report "open" over nothing.
 */
export function togglePanel(
  id: PanelId, windowWidth: number, prefs: PanelPrefs, overlay: PanelId | null,
): { prefs: PanelPrefs; overlay: PanelId | null } {
  const now = fitPanels(windowWidth, prefs, overlay);
  if (isShown(now[id])) {
    return { prefs: { ...prefs, [id]: { ...prefs[id], open: false } }, overlay: overlay === id ? null : overlay };
  }
  const next = { ...prefs, [id]: { ...prefs[id], open: true } };
  const after = fitPanels(windowWidth, next, null);
  if (after[id].docked) return { prefs: next, overlay: overlay === id ? null : overlay };
  // Only one floating panel at a time: two overlays would cover the centre.
  return { prefs: next, overlay: id };
}
