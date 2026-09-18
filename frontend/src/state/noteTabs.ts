/**
 * Open note tabs, in the shape a browser or Obsidian uses.
 *
 * A tab is a reference, not a copy: it remembers which note of which session it
 * shows, never the note's text. Reopening the app therefore shows what the user
 * left open without ever resurrecting a stale copy of a document that changed
 * underneath — the content is always read from the session it belongs to.
 *
 * Tabs are pinned to their own session on purpose. A note generated from one
 * lecture must keep citing that lecture's transcript even while the user browses
 * another session in the sidebar; letting the "current" session leak in would
 * silently point a citation at the wrong recording.
 */

export interface NoteTab {
  /** Stable per-tab identity, so two tabs on the same note stay distinguishable. */
  id: string;
  sessionId: string;
  /** Null until the first save: a tab created empty has no note behind it yet. */
  noteId: string | null;
  title: string;
}

export interface TabsState {
  tabs: NoteTab[];
  activeTabId: string | null;
}

const STORAGE_KEY = 'audiohelper.noteTabs';
/** Enough for a working set; beyond this the strip stops being navigable anyway. */
const MAX_TABS = 24;

export const emptyTabs: TabsState = { tabs: [], activeTabId: null };

let counter = 0;
export function newTabId(): string {
  counter += 1;
  return `tab-${Date.now().toString(36)}-${counter}`;
}

export function openTab(state: TabsState, tab: Omit<NoteTab, 'id'>): TabsState {
  // Opening a note that is already open focuses it instead of duplicating it,
  // which is what every tabbed editor does and what "открыть существующий" means.
  const existing = tab.noteId
    ? state.tabs.find((open) => open.sessionId === tab.sessionId && open.noteId === tab.noteId)
    : undefined;
  if (existing) return { ...state, activeTabId: existing.id };
  const created: NoteTab = { ...tab, id: newTabId() };
  const tabs = [...state.tabs, created].slice(-MAX_TABS);
  return { tabs, activeTabId: created.id };
}

export function closeTab(state: TabsState, tabId: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeTabId !== tabId) return { ...state, activeTabId: state.activeTabId };
  // Focus the neighbour the user was most likely reading before, as browsers do.
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeTabId: next?.id ?? null };
}

export function selectTab(state: TabsState, tabId: string): TabsState {
  return state.tabs.some((tab) => tab.id === tabId) ? { ...state, activeTabId: tabId } : state;
}

export function renameTab(state: TabsState, tabId: string, title: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, title } : tab)),
  };
}

/** Bind a tab created empty to the note it became on first save. */
export function attachNote(state: TabsState, tabId: string, noteId: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, noteId } : tab)),
  };
}

/** Drop tabs whose note or session no longer exists, so a deleted note cannot linger. */
export function pruneTabs(state: TabsState, known: (tab: NoteTab) => boolean): TabsState {
  const tabs = state.tabs.filter(known);
  if (tabs.length === state.tabs.length) return state;
  const active = tabs.some((tab) => tab.id === state.activeTabId)
    ? state.activeTabId
    : (tabs.at(-1)?.id ?? null);
  return { tabs, activeTabId: active };
}

export function activeTab(state: TabsState): NoteTab | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

/**
 * The first heading of a note, which is what its tab and its file are named after.
 *
 * Returns an empty string for a document that has no heading yet; the caller picks
 * the fallback, because "Конспект" is a UI word and does not belong in this module.
 */
export function titleFromContent(content: string): string {
  const line = content.split('\n').find((candidate) => candidate.trim());
  return (line ?? '').replace(/^#+\s*/, '').trim().slice(0, 80);
}

/**
 * What a note is called on screen.
 *
 * The stored name wins; an unnamed note falls back to its first line, and a note
 * that has neither is labelled rather than shown blank. One function so the tab
 * strip, the list and the picker can never disagree about a note's name.
 */
export function noteName(note: { title?: string; content: string }): string {
  return note.title?.trim() || titleFromContent(note.content) || 'Без названия';
}

/**
 * Reduce a typed name the way the backend will, so the UI can tell in advance
 * that it sanitises to nothing and simply keep the previous name.
 */
export function sanitiseTitle(raw: string): string {
  let cleaned = raw.replace(/[/\\]/g, ' ').replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '').trim();
  while (cleaned.toLowerCase().endsWith('.md')) cleaned = cleaned.slice(0, -3).trim();
  return cleaned.replace(/[ .]+$/, '').trim().slice(0, 120).trim();
}

export function loadTabs(storage: Pick<Storage, 'getItem'> = localStorage): TabsState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyTabs;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return emptyTabs;
    const { tabs, activeTabId } = parsed as Partial<TabsState>;
    if (!Array.isArray(tabs)) return emptyTabs;
    // Persisted state is validated rather than trusted: a hand-edited or
    // half-written entry must not render a tab that points nowhere.
    const valid = tabs.filter((tab): tab is NoteTab =>
      typeof tab === 'object' && tab !== null
      && typeof (tab as NoteTab).id === 'string'
      && typeof (tab as NoteTab).sessionId === 'string'
      && typeof (tab as NoteTab).title === 'string'
      && ((tab as NoteTab).noteId === null || typeof (tab as NoteTab).noteId === 'string'),
    ).slice(-MAX_TABS);
    const active = valid.some((tab) => tab.id === activeTabId) ? activeTabId! : (valid.at(-1)?.id ?? null);
    return { tabs: valid, activeTabId: active };
  } catch {
    return emptyTabs;
  }
}

export function saveTabs(state: TabsState, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A full or blocked storage must never take the editor down with it: the
    // tabs simply do not survive the next restart.
  }
}
