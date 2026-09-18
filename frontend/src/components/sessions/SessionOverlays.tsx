import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { claimOpenMenu } from '../../lib/openMenu';

export function SessionDialog({ title, children, onClose, busy = false }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = ref.current!;
    const controls = () => [...panel.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), select:not(:disabled), [tabindex="0"]')];
    (controls()[0] ?? panel).focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busyRef.current) closeRef.current(); }
      if (e.key === 'Tab') {
        const items = controls();
        const first = items[0]; const last = items.at(-1);
        if (!first) { e.preventDefault(); panel.focus(); }
        else if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    };
    const keepFocus = (e: FocusEvent) => { if (!panel.contains(e.target as Node)) (controls()[0] ?? panel).focus(); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', keepFocus);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', keepFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className="session-dialog-backdrop" onMouseDown={(e) => {
    if (e.target === e.currentTarget && !busy) onClose();
  }}>
    <div className="session-dialog" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}>
      <h2 id={titleId}>{title}</h2>{children}
    </div>
  </div>, document.body);
}

export interface SessionMenuItem { label: string; action: () => void; disabled?: boolean; destructive?: boolean }
export function SessionMenu({ label, anchor, items, onClose }: {
  label: string; anchor: DOMRect; items: SessionMenuItem[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const listening = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    listening.current = true;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const release = claimOpenMenu(() => closeRef.current());
    // The right button is how the NEXT menu is asked for, and the browser sends
    // its button-down before `contextmenu`. Dismissing on it spent that click
    // closing this menu, so the user had to right click a second time.
    const outside = (e: PointerEvent) => {
      if (e.button === 2) return;
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener('pointerdown', outside);
    const dismiss = () => closeRef.current();
    const scroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) dismiss(); };
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    return () => {
      // StrictMode replays setup/cleanup while the menu DOM is still mounted.
      // Restoring the trigger focus here must not count as a user leaving it.
      listening.current = false;
      release();
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div ref={ref} className="session-menu" role="menu" aria-label={label}
    style={{ left: Math.max(8, Math.min(anchor.right - 228, window.innerWidth - 236)), top: Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - items.length * 38 - 24)) }}
    onBlur={(e) => { if (listening.current && !e.currentTarget.contains(e.relatedTarget)) onClose(); }}
    onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
    {items.map((item) => <button key={item.label} role="menuitem" disabled={item.disabled} title={item.disabled ? 'Stop recording before deleting this session.' : undefined}
      className={item.destructive ? 'session-menu__danger' : undefined}
      onClick={() => { onClose(); item.action(); }}>{item.label}</button>)}
  </div>, document.body);
}
