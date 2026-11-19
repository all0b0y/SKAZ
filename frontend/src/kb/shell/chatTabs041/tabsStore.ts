import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  captureReadingAnchor,
  restoreReadingAnchor,
  type AnchorCaptureOptions,
  type AnchorRestoreOptions,
  type AnchorRestoreResult,
  type ReadingAnchor,
} from './readingAnchor';

export interface AdjacentSelection {
  nextActiveId: string | null;
  focusId: string | null;
  index: number;
}

/**
 * Pick the adjacent tab when closing `closingId`: right neighbour first, then left, else null.
 */
export function adjacentSelection(openIds: readonly string[], closingId: string): AdjacentSelection {
  const index = openIds.indexOf(closingId);
  if (index < 0) return { nextActiveId: null, focusId: null, index: -1 };
  const nextActiveId = openIds[index + 1] ?? openIds[index - 1] ?? null;
  return { nextActiveId, focusId: nextActiveId, index };
}

export interface ChatTabsData {
  /** Ordered open tab chat IDs (unique). */
  openIds: string[];
  /** Currently visible chat ID in the centre, or null (New chat or all tabs closed). */
  activeId: string | null;
  /** Most recently closed chat ID available for reopening. */
  lastClosedId: string | null;
  /** LIFO stack of closed chat IDs (unique, oldest -> newest). */
  closedHistory: string[];
  /** True after closing the active last tab until a tab is opened/reopened or New chat starts. */
  allClosed: boolean;
  /** Per-chat reading anchors keyed by chat ID; preserved across tab close/reopen. */
  anchors: Record<string, ReadingAnchor>;
}

export interface CloseResult {
  closed: boolean;
  wasActive: boolean;
  nextActiveId: string | null;
  focusId: string | null;
}

export interface ChatTabsActions {
  /** Open a chat tab (without duplicating) and make it active. */
  open: (chatId: string) => void;
  /** Select an already-open tab; returns false if the chat is not currently open. */
  select: (chatId: string) => boolean;
  /** Switch the active view to New chat without closing existing tabs. */
  openNewChat: () => void;
  /**
   * Close a tab as view state only (never deletes or stops backend jobs).
   * Preserves the chat's reading anchor and records it for Reopen last chat.
   */
  close: (chatId: string) => CloseResult;
  /** Reopen the most recently closed chat tab, returning its chat ID or null. */
  reopenLast: () => string | null;
  /**
   * Remove all tab/history/anchor state for a permanently deleted chat.
   */
  forget: (chatId: string) => CloseResult;
  setAnchor: (chatId: string, anchor: ReadingAnchor) => void;
  getAnchor: (chatId: string) => ReadingAnchor | undefined;
  captureAnchor: (
    chatId: string | null,
    container: HTMLElement | null | undefined,
    options?: AnchorCaptureOptions,
  ) => ReadingAnchor | null;
  restoreAnchor: (
    chatId: string | null,
    container: HTMLElement | null | undefined,
    options?: AnchorRestoreOptions,
  ) => AnchorRestoreResult;
  clearAnchor: (chatId: string) => void;
}

export type ChatTabsStore = StoreApi<ChatTabsData & ChatTabsActions>;

export interface ChatTabsInitial {
  openIds?: readonly string[];
  activeId?: string | null;
  lastClosedId?: string | null;
  closedHistory?: readonly string[];
  allClosed?: boolean;
  anchors?: Record<string, ReadingAnchor>;
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function createChatTabsStore(initial: ChatTabsInitial = {}): ChatTabsStore {
  const openIds = dedupe(initial.openIds ?? []);
  const activeId = initial.activeId && openIds.includes(initial.activeId) ? initial.activeId : null;
  const openSet = new Set(openIds);
  const seedHistory = dedupe(
    (initial.closedHistory ?? (initial.lastClosedId ? [initial.lastClosedId] : [])).filter((id) => !openSet.has(id)),
  );
  const lastClosedId = seedHistory.at(-1) ?? null;

  return createStore<ChatTabsData & ChatTabsActions>()((set, get) => ({
    openIds,
    activeId,
    lastClosedId,
    closedHistory: seedHistory,
    allClosed: initial.allClosed ?? false,
    anchors: { ...(initial.anchors ?? {}) },

    open: (chatId) => {
      if (!chatId) return;
      set((s) => {
        const nextOpenIds = s.openIds.includes(chatId) ? s.openIds : [...s.openIds, chatId];
        const nextHistory = s.closedHistory.filter((id) => id !== chatId);
        return {
          openIds: nextOpenIds,
          activeId: chatId,
          closedHistory: nextHistory,
          lastClosedId: nextHistory.at(-1) ?? null,
          allClosed: false,
        };
      });
    },

    select: (chatId) => {
      const s = get();
      if (!s.openIds.includes(chatId)) return false;
      if (s.activeId !== chatId || s.allClosed) {
        set({ activeId: chatId, allClosed: false });
      }
      return true;
    },

    openNewChat: () => {
      set({ activeId: null, allClosed: false });
    },

    close: (chatId) => {
      const s = get();
      const adj = adjacentSelection(s.openIds, chatId);
      if (adj.index < 0) {
        return { closed: false, wasActive: false, nextActiveId: s.activeId, focusId: null };
      }
      const nextOpenIds = s.openIds.filter((id) => id !== chatId);
      const wasActive = s.activeId === chatId;
      const nextActiveId = wasActive ? adj.nextActiveId : s.activeId;
      const nextHistory = [...s.closedHistory.filter((id) => id !== chatId), chatId];
      const nextAllClosed = wasActive ? nextOpenIds.length === 0 : s.allClosed;

      set({
        openIds: nextOpenIds,
        activeId: nextActiveId,
        closedHistory: nextHistory,
        lastClosedId: chatId,
        allClosed: nextAllClosed,
      });

      return {
        closed: true,
        wasActive,
        nextActiveId,
        focusId: adj.focusId,
      };
    },

    reopenLast: () => {
      const id = get().lastClosedId;
      if (!id) return null;
      get().open(id);
      return id;
    },

    forget: (chatId) => {
      const s = get();
      const adj = adjacentSelection(s.openIds, chatId);
      const wasOpen = adj.index >= 0;
      const wasActive = s.activeId === chatId;
      const nextOpenIds = wasOpen ? s.openIds.filter((id) => id !== chatId) : s.openIds;
      const nextActiveId = wasActive ? adj.nextActiveId : s.activeId;
      const nextHistory = s.closedHistory.filter((id) => id !== chatId);
      const nextAnchors = { ...s.anchors };
      delete nextAnchors[chatId];

      set({
        openIds: nextOpenIds,
        activeId: nextActiveId,
        closedHistory: nextHistory,
        lastClosedId: nextHistory.at(-1) ?? null,
        allClosed: wasActive && nextOpenIds.length === 0 ? true : s.allClosed,
        anchors: nextAnchors,
      });

      return {
        closed: wasOpen,
        wasActive,
        nextActiveId,
        focusId: adj.focusId,
      };
    },

    setAnchor: (chatId, anchor) => {
      if (!chatId) return;
      set((s) => ({
        anchors: { ...s.anchors, [chatId]: anchor },
      }));
    },

    getAnchor: (chatId) => get().anchors[chatId],

    captureAnchor: (chatId, container, options) => {
      if (!chatId) return null;
      const anchor = captureReadingAnchor(container, options);
      if (!anchor) return null;
      get().setAnchor(chatId, anchor);
      return anchor;
    },

    restoreAnchor: (chatId, container, options) => {
      const anchor = chatId ? get().getAnchor(chatId) : undefined;
      return restoreReadingAnchor(container, anchor, options);
    },

    clearAnchor: (chatId) => {
      set((s) => {
        if (!(chatId in s.anchors)) return s;
        const nextAnchors = { ...s.anchors };
        delete nextAnchors[chatId];
        return { anchors: nextAnchors };
      });
    },
  }));
}
