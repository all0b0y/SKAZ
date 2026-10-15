import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbFolder, KbLibrary, KbMaterialSummary } from '../../api/kb/types.gen';
import { errorText, type KbClient } from '../api/client';

export type Load = 'idle' | 'loading' | 'ready' | 'error';

/** Result of a user action: success, or the backend's reason to show next to the control. */
export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

export interface LibraryData {
  /** `/kb/library` — null until the first answer. */
  library: KbLibrary | null;
  libraryLoad: Load;
  libraryError: string | null;
  folders: KbFolder[];
  /** All materials, newest first (for "Recent" and "All materials · N"). */
  materials: KbMaterialSummary[];
  contentLoad: Load;
  contentError: string | null;
  /** Folder currently opened in the side panel, its materials from `/kb/materials?folder_id=`. */
  openFolderId: string | null;
  folderMaterials: KbMaterialSummary[];
  folderLoad: Load;
  folderError: string | null;
  /** Bumped whenever the set of materials may have changed (reload, deletion): other lists re-read on it. */
  revision: number;
  /** Materials known to be deleted in this window: lists with their own copy (All materials) hide them at once. */
  gone: string[];
}

export interface LibraryActions {
  loadLibrary: () => Promise<void>;
  loadContent: () => Promise<void>;
  connect: (path: string | null) => Promise<ActionResult<KbLibrary>>;
  retry: () => Promise<ActionResult<KbLibrary>>;
  createFolder: (name: string) => Promise<ActionResult<KbFolder>>;
  renameFolder: (id: string, name: string) => Promise<ActionResult<KbFolder>>;
  deleteFolder: (id: string) => Promise<ActionResult>;
  openFolder: (id: string | null) => Promise<void>;
  /**
   * A material is gone (deleted from any place, or the backend answered "not found"): drop it from
   * every list now, tell the window (`onForget`: close a panel that shows it), then re-read the lists.
   */
  forgetMaterial: (id: string, options?: { keepPanel?: boolean }) => Promise<void>;
}

export interface LibraryOptions {
  /** Called once per forgotten material, before the lists are re-read. */
  onForget?: (id: string, options: { keepPanel: boolean }) => void;
}

export type LibraryStore = StoreApi<LibraryData & LibraryActions>;

/** While the backend rescans the library (`indexing`), re-read its state this often — one read at a time. */
export const INDEXING_POLL_MS = 1500;

const newestFirst = (a: KbMaterialSummary, b: KbMaterialSummary) => b.created_at.localeCompare(a.created_at);

/** Inbox first, then by name — the order of the side panel. */
export function sortFolders(folders: KbFolder[]): KbFolder[] {
  return [...folders].sort((a, b) => {
    if (a.system !== b.system) return a.system ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export function createLibraryStore(client: KbClient, options: LibraryOptions = {}): LibraryStore {
  let indexingTimer: ReturnType<typeof setTimeout> | null = null;
  return createStore<LibraryData & LibraryActions>()((set, get) => {
    /** Follow a running scan: the next read starts after the previous answered; content reloads at the end. */
    const followIndexing = (library: KbLibrary) => {
      if (!library.indexing || indexingTimer) return;
      indexingTimer = setTimeout(() => {
        void (async () => {
          let next: KbLibrary;
          try {
            next = await client.library();
          } catch {
            indexingTimer = null;
            followIndexing(library); // a missed read changes nothing; try again later
            return;
          }
          indexingTimer = null;
          set({ library: next });
          if (!next.indexing && next.state === 'ready') await get().loadContent();
          followIndexing(next);
        })();
      }, INDEXING_POLL_MS);
    };
    return {
      library: null,
      libraryLoad: 'idle',
      libraryError: null,
      folders: [],
      materials: [],
      contentLoad: 'idle',
      contentError: null,
      openFolderId: null,
      folderMaterials: [],
      folderLoad: 'idle',
      folderError: null,
      revision: 0,
      gone: [],

      loadLibrary: async () => {
        set({ libraryLoad: 'loading', libraryError: null });
        try {
          const library = await client.library();
          set({ library, libraryLoad: 'ready' });
          followIndexing(library);
          if (library.state === 'ready') await get().loadContent();
        } catch (error) {
          set({ libraryLoad: 'error', libraryError: errorText(error) });
        }
      },

      loadContent: async () => {
        set({ contentLoad: 'loading', contentError: null });
        try {
          const folderId = get().openFolderId;
          const [folders, materials, inFolder] = await Promise.all([
            client.folders(), client.materials(), folderId ? client.materials(folderId).catch(() => null) : Promise.resolve(null),
          ]);
          set((s) => ({
            folders: sortFolders(folders),
            materials: [...materials].sort(newestFirst),
            contentLoad: 'ready',
            revision: s.revision + 1,
            // The open folder follows the same reload (a recording, an import or a deletion changes it too).
            ...(folderId && inFolder && s.openFolderId === folderId
              ? { folderMaterials: [...inFolder].sort(newestFirst), folderLoad: 'ready' as const, folderError: null } : {}),
          }));
        } catch (error) {
          set({ contentLoad: 'error', contentError: errorText(error) });
        }
      },

      forgetMaterial: async (id, { keepPanel = false } = {}) => {
        const gone = [...get().materials, ...get().folderMaterials].find((m) => m.id === id);
        set((s) => ({
          materials: s.materials.filter((m) => m.id !== id),
          folderMaterials: s.folderMaterials.filter((m) => m.id !== id),
          folders: gone ? s.folders.map((f) => (f.id === gone.folder_id ? { ...f, material_count: Math.max(0, f.material_count - 1) } : f)) : s.folders,
          revision: s.revision + 1,
          gone: s.gone.includes(id) ? s.gone : [...s.gone, id],
        }));
        options.onForget?.(id, { keepPanel });
        await get().loadContent();
      },

      connect: async (path) => {
        try {
          const library = await client.connectLibrary(path);
          set({ library, libraryLoad: 'ready', libraryError: null });
          followIndexing(library);
          if (library.state === 'ready') await get().loadContent();
          return { ok: true, value: library };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      retry: async () => {
        try {
          const library = await client.retryLibrary();
          set({ library, libraryLoad: 'ready', libraryError: null });
          followIndexing(library);
          if (library.state === 'ready') await get().loadContent();
          return { ok: true, value: library };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      createFolder: async (name) => {
        try {
          const folder = await client.createFolder(name.trim());
          set({ folders: sortFolders([...get().folders, folder]) });
          return { ok: true, value: folder };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      renameFolder: async (id, name) => {
        try {
          const folder = await client.renameFolder(id, name.trim());
          set({ folders: sortFolders(get().folders.map((f) => (f.id === id ? folder : f))) });
          return { ok: true, value: folder };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      deleteFolder: async (id) => {
        try {
          await client.deleteFolder(id);
          set({
            folders: get().folders.filter((f) => f.id !== id),
            ...(get().openFolderId === id ? { openFolderId: null, folderMaterials: [] } : {}),
          });
          return { ok: true, value: undefined };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      openFolder: async (id) => {
        if (id === null) {
          set({ openFolderId: null, folderMaterials: [], folderLoad: 'idle', folderError: null });
          return;
        }
        set({ openFolderId: id, folderMaterials: [], folderLoad: 'loading', folderError: null });
        try {
          const list = await client.materials(id);
          if (get().openFolderId !== id) return;
          set({ folderMaterials: [...list].sort(newestFirst), folderLoad: 'ready' });
        } catch (error) {
          if (get().openFolderId !== id) return;
          set({ folderLoad: 'error', folderError: errorText(error) });
        }
      },
    };
  });
}
