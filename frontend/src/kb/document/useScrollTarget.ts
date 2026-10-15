import { useEffect, useRef } from 'react';

/**
 * Bring `[data-target-key=<key>]` inside `container` into view and mark it for a moment, once per
 * `nonce` (a new openDocument of the same target runs it again). Scroll is instant under reduced
 * motion; the mark is a static outline that fades by CSS, not a blink.
 */
export function useScrollTarget(container: HTMLElement | null, key: string | null, nonce: number, ready: boolean) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!container || !key || !ready) return undefined;
    const tag = `${nonce}:${key}`;
    if (done.current === tag) return undefined;
    const el = container.querySelector<HTMLElement>(`[data-target-key="${key.replace(/["\\]/g, '\\$&')}"]`);
    if (!el) return undefined;
    done.current = tag;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    el.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    el.setAttribute('data-targeted', 'true');
    const timer = window.setTimeout(() => el.removeAttribute('data-targeted'), 2400);
    return () => window.clearTimeout(timer);
  }, [container, key, nonce, ready]);
}
