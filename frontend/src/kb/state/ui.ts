import { createStore, type StoreApi } from 'zustand/vanilla';
import { createNavSlice, type NavActions, type NavState } from './document';

export type SettingsSection = 'conn' | 'models' | 'rec' | 'wiki' | 'storage' | 'privacy' | 'look' | 'about';

/**
 * Transient UI state of the window (not persisted): what is open right now.
 * The right panel / centre navigation (`openDocument`, `openDoc`, `closeDoc`, …) is in
 * `./document.ts`; `docMaterialId` stays for the U1 callers.
 */
export interface UiState extends NavState, NavActions {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** "Library isn't connected" → the first-launch library step, on its own. */
  librarySetupOpen: boolean;
  /** "+ Material" window (U3). */
  addMaterialOpen: boolean;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  setLibrarySetupOpen: (open: boolean) => void;
  setAddMaterialOpen: (open: boolean) => void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    ...createNavSlice(set),
    settingsOpen: false,
    settingsSection: 'look',
    librarySetupOpen: false,
    addMaterialOpen: false,
    openSettings: (section) => set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection })),
    closeSettings: () => set({ settingsOpen: false }),
    setSettingsSection: (section) => set({ settingsSection: section }),
    setLibrarySetupOpen: (open) => set({ librarySetupOpen: open }),
    setAddMaterialOpen: (open) => set({ addMaterialOpen: open }),
  }));
}
