import {
  useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';
import { EXIT, SPRING_SMALL } from './motion';
import { boundaryFor, focusableIn, placePopup, type Placement } from './geometry';
import { Icon, type IconName } from './Icon';
import { boxIn, springEasing } from './ActiveTab';
import { useMotionLevel, type MotionLevel } from './motionLevel';

/** GlideSelect (stage 6, B1): the rows that take the one gliding highlight of a menu. */
const GLIDE_ROW = '.kb-menu__item';
export const GLIDE_FADE_IN_MS = 100;
export const GLIDE_FADE_OUT_MS = 120;
const GLIDE_SPRING = springEasing(0.26, 0); // SPRING_SMALL's feel, as in the demo (WAAPI on the transform)

interface GlideBox { top: number; left: number; width: number; height: number }
const glideTransform = (b: GlideBox) => `translate(${b.left}px, ${b.top}px)`;

/**
 * One highlight per menu (motion6 demo B1): it glides between rows as the pointer or the arrow keys
 * move (full), re-fades at the new row (calm) or jumps (off). It is decoration only: keyboard focus
 * stays real DOM focus on the row (arrows still move it), and the highlight follows that focus when
 * it is visible (`:focus-visible`) — a menu opened by the mouse shows nothing until a row is hovered.
 */
function useGlide(enabled: boolean, open: boolean) {
  const level = useMotionLevel();
  const levelRef = useRef<MotionLevel>(level);
  levelRef.current = level;
  const glideRef = useRef<HTMLSpanElement | null>(null);
  const cur = useRef<HTMLElement | null>(null);
  const hovered = useRef<HTMLElement | null>(null);
  /** A key was pressed inside the menu since the pointer last moved: focus moves are keyboard moves. */
  const keyboard = useRef(false);
  /** The row the pointer gave focus to (cleared once a key moves on): leaving the menu takes it back. */
  const pointerFocus = useRef<HTMLElement | null>(null);

  const popOf = () => glideRef.current?.parentElement ?? null;
  const play = (frames: Keyframe[], options: KeyframeAnimationOptions) => {
    const el = glideRef.current;
    if (el && typeof el.animate === 'function') el.animate(frames, options);
  };
  const stop = () => glideRef.current?.getAnimations?.().forEach((a) => a.cancel());

  const go = (row: HTMLElement) => {
    const el = glideRef.current;
    const pop = popOf();
    if (!el || !pop || row === cur.current) return;
    const from = cur.current && cur.current.isConnected ? boxIn(pop, cur.current) : null;
    const to = boxIn(pop, row);
    cur.current = row;
    stop();
    el.style.transform = glideTransform(to);
    el.style.width = `${to.width}px`;
    el.style.height = `${to.height}px`;
    el.style.opacity = '1';
    const now = levelRef.current;
    if (now === 'off') return;
    if (!from) { play([{ opacity: 0 }, { opacity: 1 }], { duration: GLIDE_FADE_IN_MS, easing: 'ease-out' }); return; }
    if (now === 'full') {
      play([
        { transform: glideTransform(from), width: `${from.width}px`, height: `${from.height}px` },
        { transform: glideTransform(to), width: `${to.width}px`, height: `${to.height}px` },
      ], { duration: GLIDE_SPRING.duration, easing: GLIDE_SPRING.easing });
    } else {
      play([{ opacity: 0.2 }, { opacity: 1 }], { duration: GLIDE_FADE_IN_MS, easing: 'ease-out' });
    }
  };

  const hide = (instant = false) => {
    const el = glideRef.current;
    if (!el || !cur.current) return;
    cur.current = null;
    stop();
    el.style.opacity = '0';
    if (!instant && levelRef.current !== 'off') play([{ opacity: 1 }, { opacity: 0 }], { duration: GLIDE_FADE_OUT_MS, easing: 'ease-out' });
  };

  const rowOf = (target: EventTarget | null): HTMLElement | null => {
    const pop = popOf();
    if (!pop || !(target instanceof Element)) return null;
    const row = target.closest<HTMLElement>(GLIDE_ROW);
    return row && pop.contains(row) ? row : null;
  };
  const usable = (row: HTMLElement) => row.getAttribute('aria-disabled') !== 'true' && !(row as HTMLButtonElement).disabled;
  const focusVisible = (el: Element) => {
    if (keyboard.current) return true;
    try { return el.matches(':focus-visible'); } catch { return false; }
  };
  /** Where the highlight rests without a hovered row: on the keyboard-focused row, or nowhere. A
   *  disabled row the keyboard reached shows it too (focus is always visible, FIX2 C-M2). */
  const rest = () => {
    const row = rowOf(document.activeElement);
    if (row && focusVisible(row)) go(row);
    else hide();
  };
  const typing = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    || (el instanceof HTMLElement && el.isContentEditable);
  /**
   * The ARIA menu pattern (FIX2 C-M2): the row under the pointer IS the current row — it takes real
   * focus, so Enter chooses what is highlighted and keyboard focus never hides under the highlight.
   * A disabled row or a gap hands focus to the menu itself (nothing is current). Never out of a text
   * field in the menu (the model-picker search): the user is typing there.
   */
  const pointTo = (target: HTMLElement) => {
    const active = document.activeElement;
    const pop = popOf();
    if (!pop || (typing(active) && pop.contains(active))) return;
    if (active !== target) target.focus({ preventScroll: true });
    pointerFocus.current = target === pop ? null : target;
  };

  /** Re-place the highlight on its row, or take it away when the row left or can no longer be chosen. */
  const sync = () => {
    const row = cur.current;
    const el = glideRef.current;
    const pop = popOf();
    if (!row || !el || !pop) return;
    if (!row.isConnected || !pop.contains(row)) {
      if (hovered.current === row) hovered.current = null;
      if (pointerFocus.current === row) pointerFocus.current = null;
      hide(true);
      // A focused row that left drops focus to <body>: keep it in the menu (Escape, arrows still work).
      const active = document.activeElement;
      if (!active || active === document.body) pop.focus({ preventScroll: true });
      return;
    }
    if (!usable(row) && !(row === document.activeElement && focusVisible(row))) {
      if (hovered.current === row) hovered.current = null;
      hide(true);
      return;
    }
    const b = boxIn(pop, row);
    el.style.transform = glideTransform(b);
    el.style.width = `${b.width}px`;
    el.style.height = `${b.height}px`;
  };
  const syncRef = useRef(sync);
  syncRef.current = sync;

  // Rows come and go while the menu is open (search filters the model picker, a provider folds):
  // the highlight follows its row's new place at once, or leaves with it (FIX2 C-M1). Two paths,
  // because rows change in two ways: with a render of Popover itself (its parent filtered them) —
  // the layout effect re-places after every such render, before paint — or below it (an inner
  // component's own state) — one observer for the whole time the menu is open. The observer is
  // never torn down by a render, so no mutation record is dropped.
  useLayoutEffect(() => { if (enabled) sync(); });
  useEffect(() => {
    const pop = popOf();
    if (!enabled || !open || !pop || typeof MutationObserver === 'undefined') return undefined;
    const obs = new MutationObserver(() => syncRef.current());
    obs.observe(pop, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-disabled', 'disabled'] });
    return () => obs.disconnect();
  }, [enabled, open]);

  const handlers = enabled ? {
    onPointerOver: (event: { target: EventTarget | null }) => {
      const row = rowOf(event.target);
      if (!row) return; // gaps, headings, separators: the highlight stays where it is
      const pop = popOf();
      if (usable(row)) { hovered.current = row; go(row); pointTo(row); }
      else { hovered.current = null; if (pop) pointTo(pop); rest(); }
    },
    onPointerLeave: () => {
      hovered.current = null;
      const pop = popOf();
      if (pop && pointerFocus.current && document.activeElement === pointerFocus.current) pop.focus({ preventScroll: true });
      pointerFocus.current = null;
      rest();
    },
    onPointerMove: () => { keyboard.current = false; },
    onKeyDownCapture: () => { keyboard.current = true; pointerFocus.current = null; },
    onFocus: (event: { target: EventTarget | null }) => {
      const row = rowOf(event.target);
      if (row && (focusVisible(row) || row === hovered.current)) go(row);
      else if (!row && !hovered.current) hide();
    },
  } : {};

  const reset = () => { cur.current = null; hovered.current = null; keyboard.current = false; pointerFocus.current = null; };
  return { glideRef, handlers, reset };
}

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  /** Accessible name of the popup. */
  label: string;
  role?: 'dialog' | 'menu' | 'listbox';
  children: ReactNode;
  className?: string;
  /** Focus the first focusable child on open (menus always do). */
  autoFocus?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  width?: number;
  /** `pane` (default): stays inside the trigger's column. `window`: a panel wider than a narrow column
   *  (the wiki legend from the Wiki panel) may cross it, still inside the window. */
  scope?: 'pane' | 'window';
  /** GlideSelect (B1): one highlight glides between `.kb-menu__item` rows. Default: on for menus. */
  glide?: boolean;
}

/** Floating panel anchored to a trigger. Stays inside the trigger's column; Escape/outside click close it. */
export function Popover({
  open, onClose, anchorRef, placement = 'bottom-start', label, role = 'dialog', children, className,
  autoFocus = true, onKeyDown, width, scope = 'pane', glide = role === 'menu',
}: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { glideRef, handlers: glideHandlers, reset: resetGlide } = useGlide(glide, open);
  if (!open) resetGlide();
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const anchor = anchorRef.current;
    const pop = ref.current;
    if (!anchor || !pop) return undefined;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      // offsetWidth/Height: the laid-out size, not the size mid entry animation (scale).
      const size = { width: pop.offsetWidth || pop.getBoundingClientRect().width, height: pop.offsetHeight || pop.getBoundingClientRect().height };
      const next = placePopup(a, size, placement, boundaryFor(anchor, { placement, scope }));
      setPos((now) => (now && now.left === next.left && now.top === next.top ? now : next));
    };
    place();
    // Content that arrives later (a source's fragment text) makes the popup taller: place it again,
    // so near the window's bottom it flips above its anchor instead of running off-screen (QA B10).
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    ro?.observe(pop);
    window.addEventListener('resize', place);
    return () => { ro?.disconnect(); window.removeEventListener('resize', place); };
  }, [open, placement, anchorRef, scope]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open || !autoFocus || !ref.current) return;
    (focusableIn(ref.current)[0] ?? ref.current).focus({ preventScroll: true });
  }, [open, autoFocus]);

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      anchorRef.current?.focus({ preventScroll: true });
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          key="pop"
          ref={ref}
          role={role}
          aria-label={label}
          tabIndex={-1}
          className={`kb-popover${className ? ` ${className}` : ''}`}
          data-glide={glide || undefined}
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width }}
          onKeyDown={handleKey}
          {...glideHandlers}
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING_SMALL }}
          exit={{ opacity: 0, transition: EXIT }}
        >
          {glide && <span ref={glideRef} className="kb-glide" aria-hidden="true" />}
          {children}
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  /** Muted note after the label (why it is disabled, a count…). */
  note?: string;
  onSelect: () => void;
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  items: ReadonlyArray<MenuItem>;
  placement?: Placement;
}

/** Action menu (role="menu"): arrows move, Enter/Space choose, Escape closes and returns focus. */
export function Menu({ open, onClose, anchorRef, label, items, placement = 'bottom-end' }: MenuProps) {
  const id = useId();
  const listRef = useRef<HTMLDivElement | null>(null);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget;
    const all = Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'));
    if (all.length === 0) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = all[(i + 1) % all.length];
    else if (event.key === 'ArrowUp') next = all[(i - 1 + all.length) % all.length];
    else if (event.key === 'Home') next = all[0];
    else if (event.key === 'End') next = all[all.length - 1];
    else if (event.key === 'Tab') { event.preventDefault(); onClose(); return; }
    if (next) { event.preventDefault(); next.focus(); }
  };

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} label={label} role="menu" placement={placement}
      className="kb-menu" onKeyDown={move}>
      <div ref={listRef} className="kb-menu__list">
        {items.map((item) => (
          <button
            key={item.id}
            id={`${id}-${item.id}`}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={item.disabled || undefined}
            className={`kb-menu__item${item.danger ? ' is-danger' : ''}`}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              anchorRef.current?.focus({ preventScroll: true });
              item.onSelect();
            }}
          >
            {item.icon && <Icon name={item.icon} size={14} />}
            <span className="kb-menu__label">{item.label}</span>
            {item.note && <span className="kb-menu__note">{item.note}</span>}
          </button>
        ))}
      </div>
    </Popover>
  );
}
