import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DocRef } from './document';

export type SettingsSection = 'conn' | 'models' | 'rec' | 'wiki' | 'storage' | 'privacy' | 'look' | 'about';

/** What the centre column shows: the open chat, or a full-width list (decision v16). */
export type CenterView = 'chat' | 'allChats';

/** Transient UI state of the window (not persisted): what is open right now. */
export interface UiState {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** Document in the right panel (material or wiki page); null = panel closed. */
  doc: DocRef | null;
  /** Material shown in the right document panel (= doc.id when doc is a material); kept for U1 code. */
  docMaterialId: string | null;
  docExpanded: boolean;
  /** "Library isn't connected" → the first-launch library step, on its own. */
  librarySetupOpen: boolean;
  centerView: CenterView;
  /** ⌘K palette; `searchQuery` pre-fills it (e.g. from a side-panel search). */
  searchOpen: boolean;
  /** Notification whose decision window is open (decision 18: only by a click). */
  decisionId: string | null;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  /** U1 entry point: open a material. Same as openDocument({ type: 'material', id }). */
  openDoc: (materialId: string) => void;
  openDocument: (ref: DocRef) => void;
  closeDoc: () => void;
  toggleDocExpanded: () => void;
  setLibrarySetupOpen: (open: boolean) => void;
  setCenterView: (view: CenterView) => void;
  setSearchOpen: (open: boolean) => void;
  openDecision: (id: string | null) => void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    settingsOpen: false,
    settingsSection: 'look',
    doc: null,
    docMaterialId: null,
    docExpanded: false,
    librarySetupOpen: false,
    centerView: 'chat',
    searchOpen: false,
    decisionId: null,
    openSettings: (section) => set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection })),
    closeSettings: () => set({ settingsOpen: false }),
    setSettingsSection: (section) => set({ settingsSection: section }),
    openDoc: (materialId) => set({ doc: { type: 'material', id: materialId }, docMaterialId: materialId }),
    openDocument: (ref) => set({ doc: ref, docMaterialId: ref.type === 'material' ? ref.id : null }),
    closeDoc: () => set({ doc: null, docMaterialId: null, docExpanded: false }),
    toggleDocExpanded: () => set((s) => ({ docExpanded: !s.docExpanded })),
    setLibrarySetupOpen: (open) => set({ librarySetupOpen: open }),
    setCenterView: (view) => set({ centerView: view }),
    setSearchOpen: (open) => set({ searchOpen: open }),
    openDecision: (id) => set({ decisionId: id }),
  }));
}
