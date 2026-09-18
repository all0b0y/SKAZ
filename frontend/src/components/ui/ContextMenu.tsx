import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { claimOpenMenu } from '../../lib/openMenu';

interface Props {
  /** Viewport coordinates of the click that opened the menu. */
  x: number;
  y: number;
  label: string;
  onDismiss: () => void;
  children: ReactNode;
}

/** Kept clear of the window edge so the last item is never cut off. */
const MARGIN = 8;

/**
 * A menu that opens where the pointer is, not where its owner sits.
 *
 * Both places that need one — a note tab and a selection inside the document —
 * live in boxes that scroll and clip (`overflow-x: auto` on the tab strip, the
 * scrolling editor). An absolutely positioned dropdown anchored inside them gets
 * rendered and then cut away, which is why this one is fixed to the viewport and
 * clamps itself against the window instead.
 */
export function ContextMenu({ x, y, label, onDismiss, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: y, left: x });
  // Read through a ref so claiming the window's one menu slot does not re-run
  // whenever the owner re-renders with a fresh callback.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const maxLeft = window.innerWidth - box.width - MARGIN;
    const maxTop = window.innerHeight - box.height - MARGIN;
    setPosition({
      top: Math.max(MARGIN, Math.min(y, maxTop)),
      left: Math.max(MARGIN, Math.min(x, maxLeft)),
    });
  }, [x, y]);

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
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ top: position.top, left: position.left }}
    >
      {children}
    </div>
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
