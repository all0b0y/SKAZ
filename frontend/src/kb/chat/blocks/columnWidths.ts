import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

// Presentation only: opaque message/block ids and pixels, never answer text or sources.
const STORAGE_KEY = 'skaz.kb.compare-widths';
const MAX_TABLES = 200;
// The row-label column plus the catalog's at most six comparison criteria.
const MAX_TABLE_COLUMNS = 1 + 6;
export const MIN_COLUMN_WIDTH = 144;
const MAX_COLUMN_WIDTH = 1200;
const KEY_STEP = 16;
type Saved = Array<[string, number[]]>;
const clamp = (px: number) => Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, px)));

function saved(): Saved {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.slice(-MAX_TABLES).filter((entry): entry is [string, number[]] => Array.isArray(entry)
      && entry.length === 2 && typeof entry[0] === 'string' && Array.isArray(entry[1])
      && entry[1].length > 0 && entry[1].length <= MAX_TABLE_COLUMNS
      && entry[1].every((n: unknown) => typeof n === 'number' && Number.isFinite(n)
        && n >= MIN_COLUMN_WIDTH && n <= MAX_COLUMN_WIDTH));
  } catch { return []; }
}
function read(key: string, count: number): number[] | null {
  const values = saved().reverse().find(([id]) => id === key)?.[1];
  return values?.length === count ? values : null;
}
function remember(key: string, widths: number[] | null): void {
  const entries = saved().filter(([id]) => id !== key);
  if (widths) entries.push([key, widths]);
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_TABLES))); }
  catch { /* unavailable/full storage: the current table still resizes */ }
}

interface Drag {
  id: number;
  index: number;
  x: number;
  from: number[];
  before: number[] | null;
  handle: HTMLButtonElement;
}

/** Native pointer capture, keyboard resizing and per-block layout; source/selection data is untouched. */
export function useColumnWidths(key: string, count: number, table: RefObject<HTMLTableElement | null>) {
  const [widths, setWidths] = useState<number[] | null>(() => read(key, count));
  const [measured, setMeasured] = useState<number[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const current = useRef(widths);
  const drag = useRef<Drag | null>(null);
  const apply = (next: number[] | null) => { current.current = next; setWidths(next); };
  const measure = () => Array.from(table.current?.tHead?.rows[0]?.cells ?? [], (cell) =>
    clamp(cell.getBoundingClientRect().width));
  const values = () => current.current ?? measure();
  const refresh = () => {
    if (current.current) return;
    const next = measure();
    setMeasured((before) => before.length === next.length && before.every((n, i) => n === next[i]) ? before : next);
  };

  const release = (state: Drag) => {
    if (state.handle.hasPointerCapture?.(state.id)) state.handle.releasePointerCapture(state.id);
  };
  const cancel = () => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    setActive(null);
    apply(state.before);
    release(state);
  };

  useLayoutEffect(() => {
    apply(read(key, count));
    refresh();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
    if (table.current?.parentElement) observer?.observe(table.current.parentElement);
    const blur = () => cancel();
    window.addEventListener('blur', blur);
    return () => { observer?.disconnect(); window.removeEventListener('blur', blur); if (drag.current) release(drag.current); drag.current = null; };
    // This effect owns one table identity; event handlers read the current pixel array from its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, count, table]);
  // Measure auto-layout only after React removed explicit widths (including Reset).
  useLayoutEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [widths, key, count, table]);

  const reset = () => { cancel(); apply(null); remember(key, null); };
  const resize = (index: number, px: number, baseline = values()) => baseline.map((n, i) => i === index ? clamp(px) : n);
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const next = resize(state.index, state.from[state.index]! + event.clientX - state.x, state.from);
    drag.current = null;
    setActive(null);
    apply(next);
    remember(key, next);
    release(state);
    event.stopPropagation();
  };

  const handle = (index: number) => ({
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': MIN_COLUMN_WIDTH,
    'aria-valuemax': MAX_COLUMN_WIDTH,
    'aria-valuenow': widths?.[index] ?? measured[index] ?? MIN_COLUMN_WIDTH,
    'data-resizing': active === index ? 'true' : undefined,
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      const from = values();
      if (from.length !== count) return;
      const button = event.currentTarget;
      button.focus({ preventScroll: true });
      drag.current = { id: event.pointerId, index, x: event.clientX, from, before: current.current, handle: button };
      setActive(index);
      button.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const state = drag.current;
      if (!state || state.id !== event.pointerId) return;
      apply(resize(state.index, state.from[state.index]! + event.clientX - state.x, state.from));
      event.stopPropagation();
    },
    onPointerUp: finish,
    onPointerCancel: () => cancel(),
    onLostPointerCapture: () => cancel(),
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); },
    onDoubleClick: reset,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const before = values();
      if (before.length !== count) return;
      const px = event.key === 'Home' ? MIN_COLUMN_WIDTH : event.key === 'End' ? MAX_COLUMN_WIDTH
        : before[index]! + (event.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP);
      const next = resize(index, px, before);
      apply(next);
      remember(key, next);
    },
  });
  return { widths, handle };
}
