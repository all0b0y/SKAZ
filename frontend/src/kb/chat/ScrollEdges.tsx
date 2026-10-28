import { useEffect, useState, type RefObject } from 'react';

/*
 * Stage 6 B2 — GradualBlur (DESIGN-SYSTEM.md decision 30; look and timings: the demo
 * .dev/ui-blocks/motion6 motion-v1 card B2). The thread fades and softly blurs as it scrolls under the
 * title bar and above the composer; each edge hides at its own scroll end (no blur at the top while
 * you are at the top). Four stacked backdrop-filter layers (0.5 / 1 / 2 / 4 px) with gradient masks
 * and a pane-tone fade, 44 px. The edges never take the pointer (selection, quote chips and links
 * under them keep working) and the thread keeps native scrolling (no scroll hijacking, «No Lenis»).
 * Motion: the edges switch with a 0.16 s opacity fade at full and calm, instantly at off (CSS).
 */

export interface Edges { top: boolean; bottom: boolean }

/** Which edges have thread content hidden behind them (1 px of slack against sub-pixel scroll ends). */
export function scrollEdges(el: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>): Edges {
  return { top: el.scrollTop > 1, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1 };
}

const LAYERS = [1, 2, 3, 4];

function Edge({ side, on }: { side: 'top' | 'bottom'; on: boolean }) {
  return (
    <div className={`kb-edge kb-edge--${side}`} data-on={on ? 'true' : 'false'} aria-hidden="true">
      {LAYERS.map((k) => <i key={k} className={`kb-edge__blur kb-edge__blur--${k}`} />)}
    </div>
  );
}

/**
 * The two soft edges of a scrolling thread. Render it as a sibling AFTER the scroll element inside a
 * positioned wrapper that is the scroll element's size (the chat stage). It follows scrolling, resizes
 * and streamed content (the scroll height grows while an answer arrives).
 */
export function ScrollEdges({ scrollRef, show }: { scrollRef: RefObject<HTMLElement | null>; show: boolean }) {
  const [edges, setEdges] = useState<Edges>({ top: false, bottom: false });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !show) return undefined;
    const update = () => setEdges((prev) => {
      const next = scrollEdges(el);
      return next.top === prev.top && next.bottom === prev.bottom ? prev : next;
    });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    // Streamed text and new messages change the scroll height without a resize of the scroller.
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); mo?.disconnect(); };
  }, [scrollRef, show]);
  if (!show) return null;
  return (
    <>
      <Edge side="top" on={edges.top} />
      <Edge side="bottom" on={edges.bottom} />
    </>
  );
}
