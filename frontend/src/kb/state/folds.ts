import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Which blocks of a chat the user folded (U2-a): the sources under an answer, a deck, a test.
 * One choice per block, kept across restarts in this profile's localStorage; no content, ids only.
 * A block nobody touched shows its default (sources folded, cards and tests open). Folding is
 * view state only: it never calls the backend or an agent, and the footnotes in the text stay.
 */
export const FOLDS_KEY = 'skaz.kb.folds';
/** The newest choices kept; older ones fall back to their default. */
export const FOLDS_MAX = 2000;

export interface FoldsState {
  folds: Readonly<Record<string, boolean>>;
  isFolded: (key: string, byDefault: boolean) => boolean;
  setFolded: (key: string, folded: boolean) => void;
}

export type FoldsStore = StoreApi<FoldsState>;

function readFolds(storage: Pick<Storage, 'getItem'> | null): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(FOLDS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  } catch {
    return {};
  }
}

export function createFoldsStore(storage: Storage | null): FoldsStore {
  const store = createStore<FoldsState>()((set, get) => ({
    folds: readFolds(storage),
    isFolded: (key, byDefault) => get().folds[key] ?? byDefault,
    setFolded: (key, folded) => set((s) => {
      // The newest choice goes last, so trimming drops the oldest ones.
      const { [key]: _old, ...rest } = s.folds;
      const entries = Object.entries({ ...rest, [key]: folded });
      return { folds: Object.fromEntries(entries.slice(Math.max(0, entries.length - FOLDS_MAX))) };
    }),
  }));
  store.subscribe((state, prev) => {
    if (state.folds === prev.folds) return;
    try { storage?.setItem(FOLDS_KEY, JSON.stringify(state.folds)); } catch { /* full or unavailable: keep in memory */ }
  });
  return store;
}
