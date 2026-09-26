import { useEffect, useRef, type ReactNode } from 'react';
import { claimOpenMenu } from '../../lib/openMenu';
import { usePanePlacement } from '../../hooks/usePanePlacement';
import { PanePortal } from './PanePortal';

interface Props {
  /** Viewport coordinates of the click that opened the menu. */
  x: number;
  y: number;
  label: string;
  onDismiss: () => void;
  children: ReactNode;
}

/**
 * A menu that opens where the pointer is, not where its owner sits.
 *
 * Its owners live in boxes that scroll and clip (the tab strip, the scrolling
 * editor, the chat list), so it is fixed rather than absolutely positioned — but
 * it stays inside the column it was raised in (.dev/docs/PANES-SPEC.md §1): at
 * the column edge it opens the other way, and in a column narrower than itself
 * it shrinks and wraps instead of spilling over the neighbouring column.
 */
export function ContextMenu({ x, y, label, onDismiss, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  // Read through a ref so claiming the window's one menu slot does not re-run
  // whenever the owner re-renders with a fresh callback.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  usePanePlacement(ref, () => ({ x, y }), { boundsFrom: marker }, [x, y]);

  useEffect(() => {
    const dismiss = () => onDismissRef.current();
    return claimOpenMenu(dismiss);
  }, []);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      // A right click is a request for a menu, not a dismissal. The browser sends
      // this button-down BEFORE the `contextmenu` that opens the next menu, so
      // treating it as "click outside" spent the user's click closing this menu
      // and the one they asked for never appeared.
      if (event.button === 2) return;
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', onDismiss);
    };
  }, [onDismiss]);

  return (
    <PanePortal markerRef={marker}>
      <div
        ref={ref}
        className="context-menu"
        role="menu"
        aria-label={label}
      >
        {children}
      </div>
    </PanePortal>
  );
}

interface ItemProps {
  /** Why the action cannot run right now, shown on the item itself. */
  hint?: string | null;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

/**
 * One action. An action that cannot run stays visible and says why: hiding it
 * would make the menu change shape between selections and leave the user unable
 * to tell that the action exists at all.
 */
export function ContextMenuItem({ hint, disabled, onClick, children }: ItemProps) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
      <span>{children}</span>
      {disabled && hint && <small>{hint}</small>}
    </button>
  );
}
