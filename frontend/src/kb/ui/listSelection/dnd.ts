import { useSyncExternalStore } from 'react';

/**
 * Dragging items inside the window (0.3.1 F3): HTML5 drag and drop with the payload
 * `application/x-skaz-items` = JSON `[{type, id}]`. While a drag lasts, its description is known
 * here (`currentDrag`), because a drop target can't read the data before the drop — that is how
 * a folder dims with the reason ("being recorded") or the chat field shows "Drop to attach".
 */
export const ITEMS_MIME = 'application/x-skaz-items';

export type DragItemType = 'material' | 'page' | 'chat';
/** `title` travels only inside the window (in `currentDrag`); the MIME payload is `{type, id}`. */
export interface DragItem { type: DragItemType; id: string; title?: string }
export interface DragInfo {
  items: DragItem[];
  /** Shown on the dragged card: the first title. */
  title: string;
  /** Why these items can't be moved anywhere (being recorded, being added to the wiki), or null. */
  blocked: string | null;
}

let current: DragInfo | null = null;
/** A target in this window took the drop (Chromium's `dropEffect` on drag end isn't reliable in Electron). */
let dropped = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function currentDrag(): DragInfo | null { return current; }

export function startItemsDrag(dt: DataTransfer, info: DragInfo, ghostFrom?: HTMLElement | null): void {
  dt.setData(ITEMS_MIME, JSON.stringify(info.items.map(({ type, id }) => ({ type, id }))));
  dt.effectAllowed = 'copyMove';
  if (ghostFrom && typeof dt.setDragImage === 'function') {
    // The card that follows the pointer: "title +N" (mockup lib-v1 «Drag»).
    const ghost = document.createElement('div');
    ghost.className = 'kb-dragghost';
    const t = document.createElement('span');
    t.textContent = info.title;
    ghost.appendChild(t);
    if (info.items.length > 1) {
      const n = document.createElement('span');
      n.className = 'kb-dragghost__n';
      n.textContent = `+${info.items.length - 1}`;
      ghost.appendChild(n);
    }
    ghostFrom.ownerDocument.body.appendChild(ghost);
    dt.setDragImage(ghost, 12, 12);
    window.setTimeout(() => ghost.remove(), 0);
  }
  current = info;
  dropped = false;
  emit();
}

/** Called by a drop target that acted on the items. */
export function markItemsDropped(): void { dropped = true; }

/** The drag is over; true when a target in this window took the drop. */
export function endItemsDrag(): boolean {
  const took = dropped;
  dropped = false;
  if (current) { current = null; emit(); }
  return took;
}

export function hasDragItems(dt: DataTransfer | null): boolean {
  return Boolean(dt && Array.from(dt.types ?? []).includes(ITEMS_MIME));
}

export function hasDragFiles(dt: DataTransfer | null): boolean {
  return Boolean(dt && Array.from(dt.types ?? []).includes('Files'));
}

const TYPES: ReadonlySet<string> = new Set(['material', 'page', 'chat']);

/** The dropped items, or null when the payload isn't ours or isn't well-formed. */
export function readDragItems(dt: DataTransfer | null): DragItem[] | null {
  if (!dt) return null;
  const raw = dt.getData(ITEMS_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const out: DragItem[] = [];
    for (const x of parsed) {
      if (!x || typeof x !== 'object') return null;
      const { type, id } = x as Record<string, unknown>;
      if (typeof type !== 'string' || !TYPES.has(type) || typeof id !== 'string' || !id) return null;
      out.push({ type: type as DragItemType, id });
    }
    return out;
  } catch {
    return null;
  }
}

/** The drag in progress, for targets that change their look while it lasts. */
export function useItemsDrag(): DragInfo | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    currentDrag,
    currentDrag,
  );
}
