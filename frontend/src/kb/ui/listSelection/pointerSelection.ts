import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

const IGNORE = '[data-sel-ignore], input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]';
export const HOLD_MS = 350;
const MOVE_PX = 6;

export type PointerFeedback =
  | { kind: 'hold'; id: string; row: HTMLElement; phase: 'pending' | 'held'; x: number; y: number }
  | { kind: 'band'; x: number; y: number; width: number; height: number };

/** Keep pointer feedback inside the surface, away from the open-row bridge. */
function feedbackBounds(list: HTMLElement) {
  const bounds = list.getBoundingClientRect();
  const side = list.closest<HTMLElement>('[data-pane="side"]');
  const right = side ? Math.min(bounds.right, side.getBoundingClientRect().right - (parseFloat(getComputedStyle(side).paddingRight) || 0)) : bounds.right;
  return { bounds, right };
}

interface Options {
  listRef: RefObject<HTMLElement | null>;
  ids: readonly string[];
  selected: ReadonlySet<string>;
  can: (id: string) => boolean;
  onChange: (ids: ReadonlySet<string>, focus: string | null, anchor: string | null) => void;
  resetKey?: unknown;
}
interface Band {
  pointerId: number;
  x: number;
  y: number;
  base: ReadonlySet<string>;
  moved: boolean;
}

/** A scrollbar press is not content selection (including non-overlay scrollbars). */
export function onScrollbar(el: Element, event: PointerEvent): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const scrolls = el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
  if (!scrolls || !el.clientWidth) return false;
  const r = el.getBoundingClientRect();
  return event.clientX - r.left - el.clientLeft >= el.clientWidth || event.clientY - r.top - el.clientTop >= el.clientHeight;
}

interface Hold {
  pointerId: number;
  x: number;
  y: number;
  id: string;
  row: HTMLElement;
  base: ReadonlySet<string>;
}

/** Pointer lifecycle only: early movement is native DnD; after holding it is reversible selection. */
export function usePointerSelection(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<Hold | null>(null);
  const band = useRef<Band | null>(null);
  const suppressClick = useRef(false);
  const [feedback, setFeedback] = useState<PointerFeedback | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const from = origin.current ?? band.current;
    origin.current = null;
    band.current = null;
    setFeedback(null);
    const list = latest.current.listRef.current;
    if (from && list?.hasPointerCapture?.(from.pointerId)) list.releasePointerCapture(from.pointerId);
  }, []);

  const reset = useCallback(() => {
    const interrupted = Boolean(origin.current || band.current);
    cancel();
    suppressClick.current = interrupted || suppressClick.current;
  }, [cancel]);
  useEffect(() => {
    const abort = reset;
    const move = (event: PointerEvent) => {
      const box = band.current;
      if (box && box.pointerId === event.pointerId) {
        const o = latest.current;
        const list = o.listRef.current;
        if (!list) { abort(); return; }
        const { bounds, right: edge } = feedbackBounds(list);
        const x = Math.max(bounds.left, Math.min(edge, event.clientX)) - bounds.left + list.scrollLeft;
        const y = Math.max(bounds.top, Math.min(bounds.bottom, event.clientY)) - bounds.top + list.scrollTop;
        if (!box.moved && Math.hypot(x - box.x, y - box.y) < 4) return;
        box.moved = true;
        const left = Math.min(x, box.x), top = Math.min(y, box.y);
        const right = Math.max(x, box.x), bottom = Math.max(y, box.y);
        const next = new Set([...box.base].filter((id) => o.ids.includes(id) && o.can(id)));
        for (const row of list.querySelectorAll<HTMLElement>('[data-sel-id]')) {
          const id = row.getAttribute('data-sel-id');
          if (!id || !o.ids.includes(id) || !o.can(id) || row.closest('[inert], [hidden]')
            || row.closest('[data-sel-list]') !== list) continue;
          const r = row.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const rx = r.left - bounds.left + list.scrollLeft, ry = r.top - bounds.top + list.scrollTop;
          if (rx < right && rx + r.width > left && ry < bottom && ry + r.height > top) next.add(id);
        }
        const drawX = Math.max(bounds.left, left - list.scrollLeft + bounds.left);
        const drawY = Math.max(bounds.top, top - list.scrollTop + bounds.top);
        setFeedback({ kind: 'band', x: drawX, y: drawY,
          width: Math.max(0, Math.min(edge, right - list.scrollLeft + bounds.left) - drawX),
          height: Math.max(0, Math.min(bounds.bottom, bottom - list.scrollTop + bounds.top) - drawY) });
        const order = o.ids.filter((id) => next.has(id));
        o.onChange(next, order[order.length - 1] ?? null, order[0] ?? null);
        event.preventDefault();
        return;
      }
      const from = origin.current;
      if (!from || from.pointerId !== event.pointerId) return;
      if (timer.current !== null) {
        if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > MOVE_PX) cancel();
        return;
      }
      if (!suppressClick.current) return;
      const o = latest.current;
      const list = o.listRef.current;
      const hit = document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target;
      const row = hit instanceof Element ? hit.closest<HTMLElement>('[data-sel-id]') : null;
      const id = row?.getAttribute('data-sel-id');
      if (!list || !id || row?.closest('[data-sel-list]') !== list || row.closest('[inert], [hidden]')) return;
      const a = o.ids.indexOf(from.id);
      const b = o.ids.indexOf(id);
      if (a < 0) { abort(); return; }
      if (b < 0) return;
      const range = o.ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      o.onChange(new Set([...from.base, ...range].filter((x) => o.ids.includes(x) && o.can(x))), id, from.id);
      if (!list.hasPointerCapture?.(event.pointerId)) list.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };
    const end = (event: PointerEvent) => {
      if (band.current?.pointerId === event.pointerId) {
        const moved = band.current.moved;
        cancel();
        suppressClick.current = moved;
      } else if (origin.current?.pointerId === event.pointerId) cancel();
    };
    const cancelled = (event: PointerEvent) => {
      if (origin.current?.pointerId === event.pointerId || band.current?.pointerId === event.pointerId) abort();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') abort(); };
    document.addEventListener('pointermove', move, { capture: true, passive: false });
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', cancelled, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', abort);
    return () => {
      abort();
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', end, true);
      document.removeEventListener('pointercancel', cancelled, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', abort);
    };
  }, [cancel, reset]);
  useEffect(reset, [options.resetKey, reset]);
  // A row can become busy, disappear or fold inert without changing the list's reset key.
  useEffect(() => {
    const from = origin.current;
    if (from && (!options.ids.includes(from.id) || !options.can(from.id) || !from.row.isConnected
      || from.row.closest('[inert], [hidden], [aria-hidden="true"]'))) reset();
  });

  const rowDown = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    cancel();
    suppressClick.current = false;
    const o = latest.current;
    const target = event.target instanceof Element ? event.target : null;
    if (event.button !== 0 || event.isPrimary === false || event.metaKey || event.ctrlKey
      || event.shiftKey || event.altKey || target?.closest(IGNORE) || !o.can(id)) return;
    const from: Hold = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, id, row: event.currentTarget, base: new Set(o.selected) };
    origin.current = from;
    const list = o.listRef.current;
    const clip = list ? feedbackBounds(list) : null;
    const x = clip && clip.right - clip.bounds.left >= 34
      ? Math.max(clip.bounds.left + 17, Math.min(clip.right - 17, event.clientX)) : event.clientX;
    setFeedback({ kind: 'hold', id, row: from.row, phase: 'pending', x, y: event.clientY });
    timer.current = setTimeout(() => {
      timer.current = null;
      const now = latest.current;
      if (origin.current !== from || !now.ids.includes(id) || !now.can(id)) return;
      suppressClick.current = true;
      setFeedback({ kind: 'hold', id, row: from.row, phase: 'held', x, y: from.y });
      now.onChange(new Set([...now.selected, id]), id, id);
    }, HOLD_MS);
  };
  const emptyDown = (event: ReactPointerEvent<HTMLElement>) => {
    const o = latest.current;
    const list = o.listRef.current;
    const target = event.target instanceof Element ? event.target : null;
    if (!list || !target || !list.contains(target) || event.defaultPrevented || event.button !== 0
      || event.isPrimary === false || !o.ids.length || target.closest('[data-sel-id]')
      || target.closest(`${IGNORE}, button, a, label, h1, h2, h3, p, thead, [data-sel-keep], [role="separator"], [role="listbox"]`)
      || document.querySelector('.kb-popover, .kb-modal-layer:not([data-closing])') || onScrollbar(target, event.nativeEvent)) return;
    reset();
    const bounds = list.getBoundingClientRect();
    const base = new Set(event.metaKey || event.ctrlKey || event.shiftKey ? o.selected : []);
    band.current = { pointerId: event.pointerId, x: event.clientX - bounds.left + list.scrollLeft,
      y: event.clientY - bounds.top + list.scrollTop, base, moved: false };
    o.onChange(base, null, null);
    list.focus({ preventScroll: true });
    list.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const consumeClick = (event: MouseEvent<HTMLElement>) => {
    if (!suppressClick.current || event.detail === 0) return false;
    suppressClick.current = false;
    return true;
  };
  const dragStart = (event: DragEvent<HTMLElement>) => {
    if (origin.current && suppressClick.current && timer.current === null) {
      event.preventDefault();
      event.stopPropagation();
    } else cancel();
  };
  return { rowDown, emptyDown, consumeClick, dragStart, reset, feedback };
}
