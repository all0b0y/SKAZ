import {
  useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';
import { EXIT, SPRING_SMALL } from './motion';
import { boundaryFor, focusableIn, placePopup, type Placement } from './geometry';
import { Icon, type IconName } from './Icon';

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
}

/** Floating panel anchored to a trigger. Stays inside the trigger's column; Escape/outside click close it. */
export function Popover({
  open, onClose, anchorRef, placement = 'bottom-start', label, role = 'dialog', children, className,
  autoFocus = true, onKeyDown, width, scope = 'pane',
}: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
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
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width }}
          onKeyDown={handleKey}
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING_SMALL }}
          exit={{ opacity: 0, transition: EXIT }}
        >
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
