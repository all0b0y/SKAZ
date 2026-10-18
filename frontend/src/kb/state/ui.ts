import type { EngineId } from '../api/names';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createNavSlice, type NavActions, type NavState } from './document';
import type { ToastData } from '../ui/Toast';

/** Files dropped from Finder on a folder row: "Add material" opens with them and that folder. */
export interface AddMaterialPreset {
  folderId: string;
  files: Array<{ path: string; name: string; size: number | null }>;
  /** Files the drop couldn't read (no path): said in the window. */
  unreadable: number;
}

export type SettingsSection = 'conn' | 'models' | 'rec' | 'wiki' | 'skills' | 'storage' | 'privacy' | 'look' | 'about';

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
  /** What the window starts with when it opened from a drop on a folder (0.3.1 F3). */
  addMaterialPreset: AddMaterialPreset | null;
  /** The one toast of the window (what just happened, Undo). */
  toast: ToastData | null;
  /** ⌘K palette. */
  searchOpen: boolean;
  /** Notification whose decision window is open (decision 18: only by a click). */
  decisionId: string | null;
  /** "Edit models…" (0.3.1 K4), opened on an agent / provider when given. */
  editModels: EditModelsTarget | null;
  openEditModels: (target?: EditModelsTarget) => void;
  /**
   * 0.3.1 S (W2): the study block of each chat the user worked with last — what the agent is told is
   * open when the block is in the thread. ✕ on the chip turns it off until the next touch.
   */
  studyFocus: Record<string, { id: string; on: boolean }>;
  focusStudy: (chatId: string, studyId: string) => void;
  dismissStudyContext: (chatId: string) => void;
  closeEditModels: () => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  setLibrarySetupOpen: (open: boolean) => void;
  setAddMaterialOpen: (open: boolean, preset?: AddMaterialPreset | null) => void;
  showToast: (toast: Omit<ToastData, 'id'>) => void;
  closeToast: () => void;
  setSearchOpen: (open: boolean) => void;
  openDecision: (id: string | null) => void;
}

export interface EditModelsTarget {
  engine?: EngineId;
  provider?: string;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    ...createNavSlice(set),
    settingsOpen: false,
    settingsSection: 'look',
    librarySetupOpen: false,
    addMaterialOpen: false,
    addMaterialPreset: null,
    toast: null,
    searchOpen: false,
    decisionId: null,
    editModels: null,
    studyFocus: {},
    focusStudy: (chatId, studyId) => set((s) => (s.studyFocus[chatId]?.id === studyId && s.studyFocus[chatId]?.on
      ? {} : { studyFocus: { ...s.studyFocus, [chatId]: { id: studyId, on: true } } })),
    dismissStudyContext: (chatId) => set((s) => (s.studyFocus[chatId]
      ? { studyFocus: { ...s.studyFocus, [chatId]: { ...s.studyFocus[chatId]!, on: false } } } : {})),
    openEditModels: (target) => set({ editModels: target ?? {} }),
    closeEditModels: () => set({ editModels: null }),
    openSettings: (section) => set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection })),
    closeSettings: () => set({ settingsOpen: false }),
    setSettingsSection: (section) => set({ settingsSection: section }),
    setLibrarySetupOpen: (open) => set({ librarySetupOpen: open }),
    setAddMaterialOpen: (open, preset = null) => set({ addMaterialOpen: open, addMaterialPreset: open ? preset : null }),
    showToast: (toast) => set((s) => ({ toast: { ...toast, id: (s.toast?.id ?? 0) + 1 } })),
    closeToast: () => set({ toast: null }),
    setSearchOpen: (open) => set({ searchOpen: open }),
    openDecision: (id) => set({ decisionId: id }),
  }));
}
