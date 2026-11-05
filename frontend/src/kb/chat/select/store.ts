import { createStore, type StoreApi } from 'zustand/vanilla';
import { MAX_SELECTED, sameTarget, type SelectedItem, type Selection, type SelectionTarget } from './model';

export interface SelectionState {
  selection: Selection | null;
  /** Pick or unpick one item; an item of another block starts a new selection. */
  toggle: (target: SelectionTarget, item: SelectedItem) => void;
  clear: () => void;
  /** Put a whole selection at once (P3-c: «Ask the agent» on a test question). */
  set: (selection: Selection) => void;
}

export type SelectionStore = StoreApi<SelectionState>;

export function createSelectionStore(): SelectionStore {
  return createStore<SelectionState>((set, get) => ({
    selection: null,
    toggle: (target, item) => {
      const now = get().selection;
      if (!now || !sameTarget(now, target)) {
        set({ selection: { ...target, items: [item] } });
        return;
      }
      const items = now.items.some((i) => i.id === item.id)
        ? now.items.filter((i) => i.id !== item.id)
        : now.items.length >= MAX_SELECTED ? now.items : [...now.items, item];
      set({ selection: items.length ? { ...now, items } : null });
    },
    clear: () => { if (get().selection) set({ selection: null }); },
    set: (selection) => set({ selection }),
  }));
}

export function isSelected(selection: Selection | null, target: SelectionTarget, id: string): boolean {
  return !!selection && sameTarget(selection, target) && selection.items.some((i) => i.id === id);
}
