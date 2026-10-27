import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useMotionLevel } from './motionLevel';

/**
 * The open item of a side list, drawn by ONE element per list (DESIGN-SYSTEM.md decisions 24, 25).
 *
 * - `bridge` — the open chat: a piece of the centre sheet (--kb-pane) that runs from the row across
 *   the list's right padding and the gutter until it touches the sheet, with two concave corners
 *   where it meets it. Switching = «Tuck & reach»: a copy at the old row tucks into the window
 *   (right to left, {@link TUCK_MS}, the EXIT easing) and the tab at the new row reaches out
 *   ({@link REACH_SPRING} after {@link REACH_DELAY_MS}). Same duration at any distance; nothing slides
 *   over other rows.
 * - `soft` — a soft tile (--kb-accent-soft) the size of the row, moved by a plain crossfade.
 *
 * Motion: full = as above; calm = the bridge appears in place, the soft tile still crossfades
 * (opacity only); off = instant. The rows are never touched: the host keeps its children, only the
 * tab moves (switching never remounts the list). Rows carry `data-tab-key`; the host is the
 * positioned element the tab is measured against (its first child must be this component).
 */
export type TabVariant = 'bridge' | 'soft';

export const TUCK_MS = 170;
export const REACH_DELAY_MS = 110;
export const REACH_SPRING = { visualDuration: 0.3, bounce: 0.12 } as const;
export const FADE_MS = 160;
const EXIT_EASING = 'cubic-bezier(0.4, 0, 1, 1)';
const OPEN = 'inset(-12px 0px -12px 0px)';
const TUCKED = 'inset(-12px 0px -12px 100%)';

/**
 * A spring with motion's (visualDuration, bounce) parameters sampled into a CSS `linear()` easing,
 * so the Web Animations API can play it on `clip-path` (which motion values do not spring).
 */
export function springEasing(visualDuration: number, bounce: number): { duration: number; easing: string } {
  const z = 1 - bounce;
  const w = 6.6 / visualDuration;
  const wd = w * Math.sqrt(Math.max(1e-6, 1 - z * z));
  const x = (t: number) => (z >= 0.999
    ? 1 - (1 + w * t) * Math.exp(-w * t)
    : 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t)));
  const duration = visualDuration * (bounce > 0 ? 1.6 : 1.25);
  const points: number[] = [];
  for (let i = 0; i <= 40; i += 1) points.push(Number(x((duration * i) / 40).toFixed(4)));
  points[40] = 1;
  return { duration: Math.round(duration * 1000), easing: `linear(${points.join(', ')})` };
}

interface Box { top: number; left: number; width: number; height: number }

/** The row's box in the host's content coordinates (scroll included, transforms ignored). */
export function boxIn(host: HTMLElement, row: HTMLElement): Box {
  let top = 0;
  let left = 0;
  let el: HTMLElement | null = row;
  while (el && el !== host) {
    top += el.offsetTop;
    left += el.offsetLeft;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent || !host.contains(parent)) {
      // The host is not on the offset chain: fall back to the visual boxes.
      const r = row.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      return { top: r.top - h.top + host.scrollTop, left: r.left - h.left + host.scrollLeft, width: r.width, height: r.height };
    }
    el = parent;
  }
  return { top, left, width: row.offsetWidth, height: row.offsetHeight };
}

function findRow(host: HTMLElement, key: string): HTMLElement | null {
  for (const el of host.querySelectorAll<HTMLElement>('[data-tab-key]')) {
    if (el.dataset.tabKey === key) return el;
  }
  return null;
}

function place(el: HTMLElement, box: Box, variant: TabVariant) {
  el.style.top = `${box.top}px`;
  el.style.height = `${box.height}px`;
  el.style.left = `${box.left}px`;
  // The bridge runs to the host's right edge (the centre sheet); the soft tile is the row's size.
  el.style.width = variant === 'soft' ? `${box.width}px` : '';
}

const canAnimate = (el: Element) => typeof (el as HTMLElement).animate === 'function';

export interface ActiveTabProps {
  host: RefObject<HTMLElement | null>;
  /** The row (its `data-tab-key`) that is open; null = no row is open. */
  activeKey: string | null;
  variant: TabVariant;
}

export function ActiveTab({ host, activeKey, variant }: ActiveTabProps) {
  const tabRef = useRef<HTMLDivElement | null>(null);
  const level = useMotionLevel();
  const shown = useRef<{ key: string; box: Box } | null>(null);
  /** Stops whatever is playing and removes its copies: rapid switches leave no debris. */
  const running = useRef<Array<() => void>>([]);

  const stopAll = () => {
    const list = running.current;
    running.current = [];
    list.forEach((stop) => stop());
  };

  const switchTo = (tab: HTMLDivElement, from: Box) => {
    stopAll();
    if (level === 'off' || !canAnimate(tab)) return;
    if (variant === 'bridge' && level === 'calm') return; // calm: the tab appears in place
    const ghost = tab.cloneNode(false) as HTMLDivElement;
    ghost.removeAttribute('data-tab-for');
    ghost.removeAttribute('data-testid');
    ghost.classList.add('kb-tab--ghost');
    place(ghost, from, variant);
    tab.parentNode?.insertBefore(ghost, tab);
    const out = variant === 'bridge'
      ? ghost.animate([{ clipPath: OPEN }, { clipPath: TUCKED }], { duration: TUCK_MS, easing: EXIT_EASING, fill: 'forwards' })
      : ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' });
    out.onfinish = () => ghost.remove();
    let spring = { duration: FADE_MS, easing: 'ease-out' };
    if (variant === 'bridge') spring = springEasing(REACH_SPRING.visualDuration, REACH_SPRING.bounce);
    const inn = variant === 'bridge'
      ? tab.animate([{ clipPath: TUCKED }, { clipPath: OPEN }], { duration: spring.duration, delay: REACH_DELAY_MS, easing: spring.easing, fill: 'backwards' })
      : tab.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out', fill: 'backwards' });
    running.current.push(() => { out.cancel(); ghost.remove(); inn.cancel(); });
  };

  /** The host's resize observer and the children it watches (kept in step with the list, FIX1 R3). */
  const observer = useRef<{ ro: ResizeObserver; watched: Set<Element> } | null>(null);
  /** Watch the host's current children: rows or groups added after mount move the open row too. */
  const observeChildren = () => {
    const el = host.current;
    const o = observer.current;
    if (!el || !o) return;
    const now = new Set<Element>(el.children);
    for (const child of o.watched) if (!now.has(child)) { o.ro.unobserve(child); o.watched.delete(child); }
    for (const child of now) if (!o.watched.has(child)) { o.ro.observe(child); o.watched.add(child); }
  };

  /** Place the tab on the open row; a change of row plays the switch. */
  const sync = () => {
    observeChildren();
    const tab = tabRef.current;
    const el = host.current;
    if (!tab || !el) return;
    const row = activeKey === null ? null : findRow(el, activeKey);
    if (!row) {
      stopAll();
      tab.hidden = true;
      tab.removeAttribute('data-tab-for');
      shown.current = null;
      return;
    }
    const box = boxIn(el, row);
    const before = shown.current;
    place(tab, box, variant);
    tab.hidden = false;
    tab.dataset.tabFor = activeKey!;
    shown.current = { key: activeKey!, box };
    if (before && before.key !== activeKey) switchTo(tab, before.box);
  };
  // After every render of the list (rows may have moved). On the first mount the host's ref is
  // attached after this component's layout effects, so the passive effect places it then.
  useLayoutEffect(sync);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(sync, []);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const remeasure = () => {
      const tab = tabRef.current;
      const key = shown.current?.key;
      if (!tab || !key) return;
      const row = findRow(el, key);
      if (!row) return;
      const box = boxIn(el, row);
      place(tab, box, variant);
      shown.current = { key, box };
    };
    const ro = new ResizeObserver(remeasure);
    ro.observe(el);
    observer.current = { ro, watched: new Set() };
    observeChildren();
    return () => { ro.disconnect(); observer.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, variant]);

  useLayoutEffect(() => () => stopAll(), []);

  return (
    <div className="kb-tablayer" aria-hidden="true">
      <div ref={tabRef} className={`kb-tab kb-tab--${variant}`} data-testid="active-tab" hidden />
    </div>
  );
}
