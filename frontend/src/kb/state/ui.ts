import { createStore, type StoreApi } from 'zustand/vanilla';
import { createNavSlice, type NavActions, type NavState } from './document';

export type SettingsSection = 'conn' | 'models' | 'rec' | 'wiki' | 'storage' | 'privacy' | 'look' | 'about';

/**
 * Transient UI state of the window (not persisted): what is open right now.
 * The right panel / centre navigation (`openDocument`, `openDoc`, `closeDoc`, `showCenter`, …)
 * is in `./document.ts`; `docMaterialId` stays for the U1 callers.
 */
export interface UiState extends NavState, NavActions {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** "Library isn't connected" → the first-launch library step, on its own. */
  librarySetupOpen: boolean;
  /** "+ Material" window. */
  addMaterialOpen: boolean;
  /** ⌘K palette. */
  searchOpen: boolean;
  /** Notification whose decision window is open (decision 18: only by a click). */
  decisionId: string | null;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  setLibrarySetupOpen: (open: boolean) => void;
  setAddMaterialOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  openDecision: (id: string | null) => void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    ...createNavSlice(set),
    settingsOpen: false,
    settingsSection: 'look',
    librarySetupOpen: false,
    addMaterialOpen: false,
    searchOpen: false,
    decisionId: null,
    openSettings: (section) => set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection })),
    closeSettings: () => set({ settingsOpen: false }),
    setSettingsSection: (section) => set({ settingsSection: section }),
    setLibrarySetupOpen: (open) => set({ librarySetupOpen: open }),
    setAddMaterialOpen: (open) => set({ addMaterialOpen: open }),
    setSearchOpen: (open) => set({ searchOpen: open }),
    openDecision: (id) => set({ decisionId: id }),
  }));
}
