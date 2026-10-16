import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type FocusEvent, type RefObject,
} from 'react';

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
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
}

export interface ListSelection {
  selected: ReadonlySet<string>;
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
    'data-selecting'?: true;
  };
  /** On each list/table of rows. */
  gridProps: { role: 'grid'; 'aria-multiselectable': true };
  listRef: RefObject<HTMLElement | null>;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
}

const EMPTY: ReadonlySet<string> = new Set();
const TEXT_ENTRY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]';

function rowElement(list: HTMLElement | null, id: string): HTMLElement | null {
  if (!list) return null;
  return Array.from(list.querySelectorAll<HTMLElement>('[data-sel-id]')).find((el) => el.getAttribute('data-sel-id') === id) ?? null;
}

function focusTarget(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>('button:not([data-sel-ignore] button), a[href], [tabindex="0"]') ?? row;
}

export function useListSelection(options: ListSelectionOptions): ListSelection {
  const { ids, resetKey } = options;
  const opts = useRef(options);
  opts.current = options;
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY);
  const [focus, setFocus] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const setListRef = useCallback((el: HTMLElement | null) => { listRef.current = el; }, []);
  const idsKey = ids.join('\n');

  const reasonOf = useCallback((id: string) => opts.current.reasonNotSelectable?.(id) ?? null, []);
  const can = useCallback((id: string) => reasonOf(id) === null, [reasonOf]);

  // Rows that left the list (deleted, moved out, filtered) leave the selection too.
  useEffect(() => {
    const present = new Set(idsKey ? idsKey.split('\n') : []);
    setSelected((s) => {
      const keep = [...s].filter((id) => present.has(id) && can(id));
      return keep.length === s.size ? s : new Set(keep);
    });
  }, [idsKey, can]);
  // Another folder or filter: start over.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) { firstReset.current = false; return; }
    setSelected(EMPTY);
    anchor.current = null;
  }, [resetKey]);

  const ordered = useMemo(() => ids.filter((id) => selected.has(id)), [ids, selected]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const focusRef = useRef(focus);
  focusRef.current = focus;

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
  const clear = useCallback(() => { setSelected(EMPTY); setShortcutsOpen(false); }, []);
  const selectAll = useCallback(() => {
    setSelected(new Set(opts.current.ids.filter(can)));
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

  const moveFocus = (id: string) => {
    setFocus(id);
    const row = rowElement(listRef.current, id);
    if (row) focusTarget(row).focus({ preventScroll: false });
  };

  const rowProps = (id: string): RowSelectionProps => ({
    'data-sel-id': id,
    role: 'row',
    'aria-selected': selected.has(id),
    onClickCapture: (event) => {
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
      if (mod || onBox || event.shiftKey || now.size > 0) {
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
      if (!handler) return;
      event.preventDefault();
      setFocus(id);
      const now = selectedRef.current;
      let list: string[];
      if (now.has(id)) list = opts.current.ids.filter((x) => now.has(x));
      else if (can(id)) { setSelected(new Set([id])); anchor.current = id; list = [id]; }
      else list = [];
      handler(list, { x: event.clientX, y: event.clientY });
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
      if (selectedRef.current.size || shortcutsOpen) {
        event.preventDefault();
        event.stopPropagation();
        clear();
      }
      return;
    }
    if (meta && key === '/') { event.preventDefault(); setShortcutsOpen((v) => !v); return; }
    if (inBar) return;
    const rowEl = target.closest<HTMLElement>('[data-sel-id]');
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
    ordered,
    focus,
    toggle,
    clear,
    selectAll,
    targets,
    reasonOf,
    rowProps,
    listProps: { ref: setListRef, onKeyDown, onKeyUp, ...(selected.size ? { 'data-selecting': true as const } : {}) },
    gridProps: { role: 'grid', 'aria-multiselectable': true },
    listRef,
    shortcutsOpen,
    setShortcutsOpen,
  };
}
