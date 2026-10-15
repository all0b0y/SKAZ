import { createStore, type StoreApi } from 'zustand/vanilla';

export type SettingsSection = 'conn' | 'models' | 'rec' | 'wiki' | 'storage' | 'privacy' | 'look' | 'about';

/** Transient UI state of the window (not persisted): what is open right now. */
export interface UiState {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** Material shown in the right document panel; null = panel closed. */
  docMaterialId: string | null;
  docExpanded: boolean;
  /** "Library isn't connected" → the first-launch library step, on its own. */
  librarySetupOpen: boolean;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  openDoc: (materialId: string) => void;
  closeDoc: () => void;
  toggleDocExpanded: () => void;
  setLibrarySetupOpen: (open: boolean) => void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    settingsOpen: false,
    settingsSection: 'look',
    docMaterialId: null,
    docExpanded: false,
    librarySetupOpen: false,
    openSettings: (section) => set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection })),
    closeSettings: () => set({ settingsOpen: false }),
    setSettingsSection: (section) => set({ settingsSection: section }),
    openDoc: (materialId) => set({ docMaterialId: materialId }),
    closeDoc: () => set({ docMaterialId: null, docExpanded: false }),
    toggleDocExpanded: () => set((s) => ({ docExpanded: !s.docExpanded })),
    setLibrarySetupOpen: (open) => set({ librarySetupOpen: open }),
  }));
}
