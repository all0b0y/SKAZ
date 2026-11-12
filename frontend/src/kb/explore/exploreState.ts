// EX3 (Explore v2): what the Explore side list and the Explore page share — the page shown (the map or
// one search), where the map stands, the picked topics, and the searches with their live counts.
// One store per library client, like weeklySelection.ts; the side panel and the page read the same one.

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbSearch, KbSearches } from '../../api/kb/types.gen';

export type ExplorePage = { kind: 'map' } | { kind: 'search'; id: string };

export interface ExploreState {
  page: ExplorePage;
  /** The map level: null = the top; a topic id = its subtopics, or its materials when it has none. */
  level: string | null;
  /** The topic a search goes to (the last clicked tile); null = all your topics. */
  selected: string | null;
  /** ⌘-clicked tiles: «Find in N topics» starts one search per topic. */
  multi: string[];
  searches: KbSearch[];
  parallelLimit: number;
  /** The searches could not be read; the side list says so and keeps the last list. */
  searchesFailed: boolean;
  showMap: () => void;
  showSearch: (id: string) => void;
  goToLevel: (level: string | null, selected?: string | null) => void;
  toggleMulti: (id: string) => void;
  clearMulti: () => void;
  /** Reread the list now (after a start, rename, delete, or a finding's state changed). */
  refresh: () => Promise<void>;
}

const busyStates = new Set(['queued', 'running']);
const POLL_MS = 1500;

type ReadSearches = () => Promise<KbSearches>;

function createExploreState(readSearches: ReadSearches): StoreApi<ExploreState> {
  let reading: Promise<void> | null = null;
  const store = createStore<ExploreState>((set, get) => ({
    page: { kind: 'map' },
    level: null,
    selected: null,
    multi: [],
    searches: [],
    parallelLimit: 3,
    searchesFailed: false,
    showMap: () => set({ page: { kind: 'map' } }),
    showSearch: (id) => set({ page: { kind: 'search', id }, multi: [] }),
    goToLevel: (level, selected = level) => set({ level, selected, multi: [] }),
    toggleMulti: (id) => set((s) => {
      const base = s.multi.length === 0 && s.selected ? [s.selected] : s.multi;
      const multi = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      return multi.length === 1 ? { multi: [], selected: multi[0] ?? null } : { multi };
    }),
    clearMulti: () => set({ multi: [] }),
    refresh: () => {
      if (reading) return reading;
      reading = readSearches().then(
        (res) => {
          const page = get().page;
          const gone = page.kind === 'search' && !res.items.some((s) => s.id === page.id);
          set({ searches: res.items, parallelLimit: res.parallel_limit, searchesFailed: false, ...(gone ? { page: { kind: 'map' } } : {}) });
        },
        () => set({ searchesFailed: true }),
      ).finally(() => { reading = null; });
      return reading;
    },
  }));
  return store;
}

const stores = new WeakMap<object, StoreApi<ExploreState>>();

/** The store of one library: `key` is its client (the app's KbClient, or a test's clients object). */
export function exploreState(key: object, readSearches: ReadSearches): StoreApi<ExploreState> {
  let store = stores.get(key);
  if (!store) { store = createExploreState(readSearches); stores.set(key, store); }
  return store;
}

const watchers = new WeakMap<StoreApi<ExploreState>, { count: number; timer: number | null }>();

/**
 * Keep the searches current while someone shows them: read once, then every 1.5 s while a search runs or
 * waits. The side list and the page both watch; one timer serves them.
 */
export function watchSearches(store: StoreApi<ExploreState>): () => void {
  let watch = watchers.get(store);
  if (!watch) { watch = { count: 0, timer: null }; watchers.set(store, watch); }
  const w = watch;
  w.count += 1;
  if (w.count === 1) {
    void store.getState().refresh();
    w.timer = window.setInterval(() => {
      if (store.getState().searches.some((s) => busyStates.has(s.state))) void store.getState().refresh();
    }, POLL_MS);
  }
  return () => {
    w.count -= 1;
    if (w.count === 0 && w.timer !== null) { window.clearInterval(w.timer); w.timer = null; }
  };
}

/** The side list's status for a search: «12/50…», «Waiting», «+3», «0 new», «Paused». */
export function searchStatus(search: KbSearch): { text: string; tone: 'run' | 'new' | 'quiet' | 'stop' } {
  if (search.state === 'running') return { text: search.found > 0 ? `${search.found} found…` : 'Searching…', tone: 'run' };
  if (search.state === 'queued') return { text: 'Waiting', tone: 'quiet' };
  if (search.state === 'paused') return { text: 'Paused', tone: 'stop' };
  if (search.state === 'error') return { text: 'Failed', tone: 'stop' };
  if (search.unseen > 0) return { text: `+${search.unseen}`, tone: 'new' };
  return { text: search.state === 'cancelled' ? 'Stopped' : '0 new', tone: 'quiet' };
}
