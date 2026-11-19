import { useEffect, useRef } from 'react';

export function findScrollTarget(container: HTMLElement, key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-target-key="${key.replace(/["\\]/g, '\\$&')}"]`);
}

/**
 * Bring `[data-target-key=<key>]` inside `container` into view and mark it for a moment, once per
 * `nonce` (a new openDocument of the same target runs it again). Scroll is instant under reduced
 * motion; the mark is a static outline that fades by CSS, not a blink.
 */
export function useScrollTarget(container: HTMLElement | null, key: string | null, nonce: number, ready: boolean,
  returningToCitation = false) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!container || !key || !ready) return undefined;
    const tag = `${nonce}:${key}`;
    if (done.current === tag) return undefined;
    const el = findScrollTarget(container, key);
    if (!el) return undefined;
    done.current = tag;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const active = container.ownerDocument.activeElement;
    // Back may have brought a different block's citation into view. Keep it visible.
    if (!(returningToCitation && active?.hasAttribute('data-reader-citation') && container.contains(active))) {
      const quote = active?.matches('mark.kb-quote, button.kb-fix.is-quote') && el.contains(active) ? active : null;
      (quote ?? el).scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
    el.setAttribute('data-targeted', 'true');
    const timer = window.setTimeout(() => el.removeAttribute('data-targeted'), 2400);
    return () => window.clearTimeout(timer);
  }, [container, key, nonce, ready, returningToCitation]);
}
