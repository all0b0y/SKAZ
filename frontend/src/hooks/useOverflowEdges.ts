import { useEffect, useState, type RefObject } from 'react';

export interface OverflowEdges {
  /** Content is hidden before the visible part (scrolled away from the start). */
  start: boolean;
  /** Content is hidden after the visible part. */
  end: boolean;
}

const SLACK = 1;

function measure(el: HTMLElement, axis: 'x' | 'y'): OverflowEdges {
  const [pos, size, total] = axis === 'x'
    ? [el.scrollLeft, el.clientWidth, el.scrollWidth]
    : [el.scrollTop, el.clientHeight, el.scrollHeight];
  return { start: pos > SLACK, end: pos + size < total - SLACK };
}

/**
 * Which ends of a scrolling box have content hidden behind them
 * (.dev/docs/PANES-SPEC.md §3–5). Mirrors the answer onto the element as
 * `data-fade-start` / `data-fade-end`, which the stylesheet turns into a soft
 * `mask-image` fade on exactly those edges, and returns it for controls that
 * appear only on overflow.
 *
 * Re-measures on scroll, on a size change of the box or its children, and when
 * its content changes. Everything but scrolling is coalesced to one measurement
 * per animation frame: a live transcript mutates many times a second and must
 * not pay a forced layout for each mutation. Reports only real changes.
 */
function watchOverflow(el: HTMLElement, axis: 'x' | 'y', onChange?: (edges: OverflowEdges) => void): () => void {
  let frame = 0;
  let last = '';
  const update = () => {
    frame = 0;
    const next = measure(el, axis);
    const key = `${next.start}:${next.end}`;
    if (key === last) return;
    last = key;
    el.toggleAttribute('data-fade-start', next.start);
    el.toggleAttribute('data-fade-end', next.end);
    onChange?.(next);
  };
  const schedule = () => {
    if (frame) return;
    if (typeof requestAnimationFrame === 'undefined') update();
    else frame = requestAnimationFrame(update);
  };
  update();
  // Scrolling is measured at once: the fade must follow the hand, not lag a frame.
  el.addEventListener('scroll', update, { passive: true });
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resize?.observe(el);
  // Children resize too (a tab shrinking, a list growing), which the box's own observer misses.
  const observeChildren = () => { for (const child of Array.from(el.children)) resize?.observe(child); };
  observeChildren();
  const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
    observeChildren();
    schedule();
  });
  mutations?.observe(el, { childList: true, subtree: true, characterData: true });
  return () => {
    if (frame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame);
    el.removeEventListener('scroll', update);
    resize?.disconnect();
    mutations?.disconnect();
  };
}

/** The edges as React state, for controls that appear only on overflow (a row's "⋯"). */
export function useOverflowEdges(ref: RefObject<HTMLElement>, axis: 'x' | 'y'): OverflowEdges {
  const [edges, setEdges] = useState<OverflowEdges>({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    return el ? watchOverflow(el, axis, setEdges) : undefined;
  }, [ref, axis]);
  return edges;
}

/**
 * The fade only, with no React state: for a column body (transcript, note, chat,
 * session list) whose owner must not re-render when the reader scrolls.
 */
export function useEdgeFade(ref: RefObject<HTMLElement>, axis: 'x' | 'y' = 'y', enabled = true): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    const stop = watchOverflow(el, axis);
    return () => {
      stop();
      el.removeAttribute('data-fade-start');
      el.removeAttribute('data-fade-end');
    };
  }, [ref, axis, enabled]);
}
