import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type FocusEvent, type RefObject, type PointerEvent as ReactPointerEvent, type DragEvent as ReactDragEvent,
} from 'react';
import { onScrollbar, usePointerSelection, type PointerFeedback } from './pointerSelection';

/**
 * Selecting several rows of one list (0.3.1 F2/F4/F5, contract in PLAN-0.3.1 «Контракт F2–F5»).
 *
 * - A plain click keeps the row's own action (open); ⌘-click, ⇧-click and the box select. Once
 *   something is selected, a plain click toggles the row. Selecting never opens anything.
 * - Keys work only in the focused list and never inside a text field: ↑↓ focus, ⇧↑↓ extend,
 *   Space toggle, ⌘A all, Esc clear, ↩ open, ⌘↩ attach to the chat, ⌘⇧M move, ⌘⌫ delete,
 *   ⌘⇧E export, ⌘/ the shortcuts list. ⌘, and ⌘K stay the app's.
 * - With nothing selected, an action applies to the focused row.
 * - The selection is local and not saved: it clears on Esc, when `resetKey` changes (another
 *   folder or filter) and when the caller calls `clear()` after an action; rows that leave the
 *   list leave the selection.
 * - Finder (F7): ⌘A with the pointer over a list selects all of it, wherever the keyboard focus is
 *   (a text field keeps its own ⌘A). A press anywhere but on a row of the list — its empty space
 *   or outside — clears at once; the selection bar, the list's menus and windows (a confirmation,
 *   ⌘/) and a click that only closes an open menu or window don't count. Esc clears even when the
 *   focus is not in the list. The boxes show only while the list is selecting (`data-selecting`).
 */
export interface ListSelectionOptions {
  /** Row ids in display order. */
  ids: readonly string[];
  /** Why a row can't be selected (shown on its box), or null. */
  reasonNotSelectable?: (id: string) => string | null;
  onOpen?: (id: string) => void;
  onAttach?: (ids: string[]) => void;
  onDelete?: (ids: string[]) => void;
  onMove?: (ids: string[]) => void;
  onExport?: (ids: string[]) => void;
  /** Right-click: the row joins (or becomes) the selection; the caller shows its menu at `at`. */
  onContextMenu?: (ids: string[], at: { x: number; y: number }) => void;
  /** Another folder, filter or section: the selection starts over. */
  resetKey?: unknown;
}

export interface RowSelectionProps {
  'data-sel-id': string;
  role: 'row';
  'aria-selected': boolean;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragStartCapture: (event: ReactDragEvent<HTMLElement>) => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
}

export interface ListSelection {
  selected: ReadonlySet<string>;
  feedback: PointerFeedback | null;
  selecting: boolean;
  choose: (ids?: readonly string[]) => void;
  toggleSet: (ids: readonly string[]) => void;
  available: readonly string[];
  reference: string | null;
  /** Selected ids in list order. */
  ordered: string[];
  focus: string | null;
  toggle: (id: string) => void;
  clear: () => void;
  selectAll: () => void;
  /** What an action applies to: the selection, else the focused row (if selectable). */
  targets: () => string[];
  reasonOf: (id: string) => string | null;
  rowProps: (id: string) => RowSelectionProps;
  /** On the element holding every row: keys, and the place rows are looked up for focus. */
  listProps: {
    ref: (el: HTMLElement | null) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
    onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
    tabIndex: -1;
    'data-sel-list': '';
    'data-selecting'?: true;
  };
  /** On each list/table of rows. */
  gridProps: { role: 'grid'; 'aria-multiselectable': true };
  listRef: RefObject<HTMLElement | null>;
  controlsRef: RefObject<HTMLDivElement>;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
}

const EMPTY: ReadonlySet<string> = new Set();
const TEXT_ENTRY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]';

function rowElement(list: HTMLElement | null, id: string): HTMLElement | null {
  if (!list) return null;
  return Array.from(list.querySelectorAll<HTMLElement>('[data-sel-id]')).find((el) =>
    el.getAttribute('data-sel-id') === id && el.closest('[data-sel-list]') === list
    && !el.closest('[inert], [hidden], [aria-hidden="true"]')) ?? null;
}

/** Presses here are not "outside" the list: its bar, its menus and windows, a tooltip, a toast. */
const KEEP = '[data-sel-bar], [data-sel-keep], .kb-popover, .kb-modal-layer, [role="menu"], [role="dialog"], [role="alertdialog"], [role="tooltip"], .kb-toast';
/** A menu or window is open: the next press only closes it. */
const OPEN_LAYER = '.kb-popover, .kb-modal-layer:not([data-closing])';

// The element under the pointer, for ⌘A over a list (one listener for every list).
let hovered: Element | null = null;
let tracking = false;
function trackPointer() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('pointerover', (event) => { hovered = event.target instanceof Element ? event.target : null; }, true);
  document.addEventListener('pointerout', (event) => { if (!event.relatedTarget) hovered = null; }, true);
}

function focusTarget(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>('button:not([data-sel-ignore] button), a[href], [tabindex="0"]') ?? row;
}

export function useListSelection(options: ListSelectionOptions): ListSelection {
  const { ids, resetKey } = options;
  const opts = useRef(options);
  opts.current = options;
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY);
  const [choosing, setChoosing] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const setListRef = useCallback((el: HTMLElement | null) => { listRef.current = el; }, []);

  const reasonOf = useCallback((id: string) => opts.current.reasonNotSelectable?.(id) ?? null, []);
  const can = useCallback((id: string) => reasonOf(id) === null, [reasonOf]);
  const available = ids.filter(can);
  const availableKey = JSON.stringify(available);

  // Rows that left the list (deleted, moved out, filtered) leave the selection too.
  useEffect(() => {
    const present = new Set<string>(JSON.parse(availableKey));
    setSelected((s) => {
      const keep = [...s].filter((id) => present.has(id) && can(id));
      return keep.length === s.size ? s : new Set(keep);
    });
  }, [availableKey, can]);
  // Another folder or filter: start over.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) { firstReset.current = false; return; }
    setSelected(EMPTY);
    setChoosing(false);
    anchor.current = null;
  }, [resetKey]);

  const ordered = useMemo(() => ids.filter((id) => selected.has(id)), [ids, selected]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const pointer = usePointerSelection({
    listRef, ids, selected, can, resetKey,
    onChange: (next, id, from) => {
      selectedRef.current = next;
      setSelected(next);
      setFocus(id);
      anchor.current = from;
    },
  });

  const toggle = useCallback((id: string) => {
    if (!can(id)) return;
    anchor.current = id;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, [can]);
  const add = useCallback((list: string[]) => {
    const ok = list.filter(can);
    if (!ok.length) return;
    setSelected((s) => (ok.every((id) => s.has(id)) ? s : new Set([...s, ...ok])));
  }, [can]);
  const clear = useCallback(() => {
    pointer.reset();
    setSelected(EMPTY);
    setChoosing(false);
    setShortcutsOpen(false);
  }, [pointer.reset]);
  const choose = useCallback((chosen?: readonly string[]) => {
    setChoosing(true);
    if (chosen !== undefined) setSelected(new Set(chosen.filter((id) => opts.current.ids.includes(id) && can(id))));
    const current = focusRef.current;
    const id = current && opts.current.ids.includes(current) && can(current) ? current : opts.current.ids.find(can);
    const row = id ? rowElement(listRef.current, id) : null;
    if (row) focusTarget(row).focus({ preventScroll: true });
  }, [can]);
  const toggleSet = useCallback((chosen: readonly string[]) => {
    setChoosing(true);
    const allowed = [...new Set(chosen)].filter((id) => opts.current.ids.includes(id) && can(id));
    setSelected((s) => {
      const next = new Set(s);
      const remove = allowed.length > 0 && allowed.every((id) => s.has(id));
      for (const id of allowed) { if (remove) next.delete(id); else next.add(id); }
      return next;
    });
  }, [can]);
  const selectAll = useCallback(() => {
    setSelected(new Set(opts.current.ids.filter(can)));
  }, [can]);
  const selectAllHere = useCallback(() => {
    const list = opts.current.ids.filter(can);
    if (!list.length) return false;
    setSelected(new Set(list));
    return true;
  }, [can]);
  const targets = useCallback(() => {
    const now = selectedRef.current;
    if (now.size) return opts.current.ids.filter((id) => now.has(id));
    const f = focusRef.current;
    return f && can(f) && opts.current.ids.includes(f) ? [f] : [];
  }, [can]);

  const range = useCallback((from: string, to: string) => {
    const list = opts.current.ids;
    const a = list.indexOf(from);
    const b = list.indexOf(to);
    if (a < 0 || b < 0) return [to];
    return list.slice(Math.min(a, b), Math.max(a, b) + 1);
  }, []);

  // ⌘A over the list under the pointer (Finder), before the focused list's own keys see it.
  useEffect(() => {
    trackPointer();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'a') return;
      const list = listRef.current;
      if (!list || !hovered || !list.contains(hovered)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(TEXT_ENTRY) || target?.closest('.kb-popover, .kb-modal-layer')) return;
      if (document.querySelector(OPEN_LAYER)) return;
      if (!selectAllHere()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectAllHere]);

  // While something is selected: a press outside the rows clears; Esc clears from anywhere.
  const selecting = choosing || selected.size > 0;
  useEffect(() => {
    if (!selecting) setReference(null);
    else setReference((value) => value ?? focusRef.current ?? opts.current.ids.find(can) ?? null);
  }, [selecting, can]);
  useEffect(() => {
    if (!selecting) return undefined;
    const onDown = (event: PointerEvent) => {
      const list = listRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!list || !target) return;
      const row = target.closest('[data-sel-id]');
      if (row && list.contains(row)) return;
      if (target.closest(KEEP)) return;
      if (document.querySelector(OPEN_LAYER)) return;
      if (onScrollbar(target, event)) return;
      clear();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && (listRef.current?.contains(target) || target.closest(TEXT_ENTRY) || target.closest(KEEP))) return;
      if (document.querySelector(OPEN_LAYER)) return;
      clear();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [selecting, clear]);

  const moveFocus = (id: string) => {
    setFocus(id);
    const row = rowElement(listRef.current, id);
    if (row) focusTarget(row).focus({ preventScroll: false });
  };

  const rowProps = (id: string): RowSelectionProps => ({
    'data-sel-id': id,
    role: 'row',
    'aria-selected': selected.has(id),
    onPointerDownCapture: (event) => pointer.rowDown(id, event),
    onDragStartCapture: pointer.dragStart,
    onClickCapture: (event) => {
      if (pointer.consumeClick(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest('[data-sel-ignore]')) return;
      const onBox = Boolean(target.closest('[data-sel-box]'));
      const mod = event.metaKey || event.ctrlKey;
      const now = selectedRef.current;
      if (event.shiftKey && (now.size > 0 || anchor.current)) {
        event.preventDefault();
        event.stopPropagation();
        add(range(anchor.current ?? id, id));
        setFocus(id);
        return;
      }
      if (mod || onBox || event.shiftKey || now.size > 0 || choosing) {
        event.preventDefault();
        event.stopPropagation();
        setFocus(id);
        toggle(id);
        return;
      }
      // A plain click with nothing selected: the row's own action (open) runs.
      anchor.current = id;
      setFocus(id);
    },
    onContextMenu: (event) => {
      const handler = opts.current.onContextMenu;
      if ((event.target as Element).closest(`[data-sel-ignore], ${TEXT_ENTRY}`) || (!handler && !can(id))) return;
      event.preventDefault();
      setFocus(id);
      const now = selectedRef.current;
      let list: string[];
      if (now.has(id)) list = opts.current.ids.filter((x) => now.has(x));
      else if (can(id)) { setSelected(new Set([id])); anchor.current = id; list = [id]; }
      else list = [];
      handler?.(list, { x: event.clientX, y: event.clientY });
    },
    onFocus: () => setFocus(id),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (!listRef.current?.contains(target)) return; // a portal (menu, tooltip) of something inside
    if (target.closest(TEXT_ENTRY)) return;
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const inBar = Boolean(target.closest('[data-sel-bar]'));
    const rowEl = target.closest<HTMLElement>('[data-sel-id]');
    // Only rows (and the bar, for Esc/⌘/) are the list: filters and other controls nearby keep their keys.
    if (!rowEl && !inBar && target !== listRef.current) return;
    const o = opts.current;
    const run = (handler: ((ids: string[]) => void) | undefined) => {
      if (!handler) return false;
      const list = targets();
      if (!list.length) return false;
      event.preventDefault();
      event.stopPropagation();
      handler(list);
      return true;
    };
    if (key === 'Escape') {
      if (selecting || shortcutsOpen) {
        event.preventDefault();
        event.stopPropagation();
        clear();
      }
      return;
    }
    if (meta && key === '/') { event.preventDefault(); setShortcutsOpen((v) => !v); return; }
    if (inBar) return;
    const current = rowEl?.getAttribute('data-sel-id') ?? focusRef.current;
    if (!meta && (key === 'ArrowDown' || key === 'ArrowUp')) {
      const list = o.ids;
      if (!list.length) return;
      event.preventDefault();
      const i = current ? list.indexOf(current) : -1;
      const next = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + (key === 'ArrowDown' ? 1 : -1)))]!;
      if (event.shiftKey) {
        add([...(current ? [current] : []), next]);
        anchor.current = anchor.current ?? current;
      }
      moveFocus(next);
      return;
    }
    if (!meta && key === ' ' && current) {
      event.preventDefault();
      toggle(current);
      return;
    }
    if (key === 'Enter' && !event.shiftKey) {
      if (meta) { run(o.onAttach); return; }
      if (current && o.onOpen) { event.preventDefault(); o.onOpen(current); }
      return;
    }
    if (!meta) return;
    if (key === 'a' && !event.shiftKey) { event.preventDefault(); selectAll(); return; }
    if (key === 'm' && event.shiftKey) { run(o.onMove); return; }
    if (key === 'e' && event.shiftKey) { run(o.onExport); return; }
    if ((key === 'Backspace' || key === 'Delete') && !event.shiftKey) { run(o.onDelete); }
  };
  // Space on a focused button would "click" it on key up: the toggle above already happened.
  const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === ' ' && target.closest('[data-sel-id]') && !target.closest(TEXT_ENTRY)) event.preventDefault();
  };

  return {
    selected,
    feedback: pointer.feedback,
    selecting,
    choose,
    toggleSet,
    available,
    reference,
    ordered,
    focus,
    toggle,
    clear,
    selectAll,
    targets,
    reasonOf,
    rowProps,
    listProps: { ref: setListRef, onKeyDown, onKeyUp, onPointerDownCapture: pointer.emptyDown, tabIndex: -1, 'data-sel-list': '', ...(selecting ? { 'data-selecting': true as const } : {}) },
    gridProps: { role: 'grid', 'aria-multiselectable': true },
    listRef,
    controlsRef,
    shortcutsOpen,
    setShortcutsOpen,
  };
}
