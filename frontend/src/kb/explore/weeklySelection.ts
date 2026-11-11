import { createStore } from 'zustand/vanilla';
import type { KbClient } from '../api/client';

const selections = new WeakMap<KbClient, ReturnType<typeof createSelection>>();
const createSelection = () => createStore<{ checkId: string | null }>(() => ({ checkId: null }));
const emptySelection = createSelection();

/** A notification target is session-local and belongs to the same library/client as Explore. */
export function weeklySelection(client?: KbClient) {
  if (!client) return emptySelection;
  let store = selections.get(client);
  if (!store) { store = createSelection(); selections.set(client, store); }
  return store;
}
