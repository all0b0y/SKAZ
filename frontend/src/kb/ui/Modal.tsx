import {
  useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m, useIsPresent } from 'motion/react';
import { EXIT, SPRING_LARGE } from './motion';
import { focusableIn } from './geometry';
import { IconButton } from './Button';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name; rendered as the header unless `bare`. */
  title: string;
  /** Hide the default header (title + close) when the content brings its own. */
  bare?: boolean;
  children: ReactNode;
  className?: string;
  /** Element to focus first; defaults to the first focusable inside, else the dialog. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Darker scrim for first launch, where nothing behind is usable yet. */
  scrim?: 'normal' | 'strong';
  /** First launch cannot be dismissed by clicking outside. */
  dismissOnScrim?: boolean;
  /** First launch has no Escape either: it is closed by its own buttons. */
  dismissOnEscape?: boolean;
  testId?: string;
  /** Marks the dialog as a column for the layout audit (scripts/paneAudit.ts). */
  pane?: string;
  /** 'dialog' focuses the window itself (its title is read first) instead of the first control. */
  initialFocus?: 'first' | 'dialog';
}

/**
 * Modal window over the app: scrim, focus trap, Escape, focus returned to the opener.
 * Focus returns the moment `open` turns false — never after the exit animation.
 */
export function Modal(props: ModalProps) {
  const { open } = props;
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  // Read the opener while rendering the opening frame, before the background turns inert.
  if (open && !wasOpen.current) {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = open;

  // Give focus back on close, right after the commit (React restores the old focus during the
  // commit itself, so this is a passive effect) — never after the exit animation.
  useEffect(() => {
    if (!open) return undefined;
    return () => {
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>{open && <ModalLayer key="layer" {...props} />}</AnimatePresence>,
    document.body,
  );
}

function ModalLayer({
  onClose, title, bare = false, children, className, initialFocusRef, scrim = 'normal',
  dismissOnScrim = true, dismissOnEscape = true, testId, pane, initialFocus = 'first',
}: ModalProps) {
  const titleId = useId();
  const present = useIsPresent();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Background is inert while the dialog is open: no tabbing or clicking behind it.
  // A layout effect, so it is lifted before the parent hands focus back to the opener.
  useLayoutEffect(() => {
    if (!present) {
      layerRef.current?.setAttribute('inert', '');
      return undefined;
    }
    const made: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === layerRef.current || child.hasAttribute('inert') || child.tagName === 'SCRIPT') continue;
      if (child.classList.contains('kb-modal-layer') || child.getAttribute('role') === 'tooltip') continue;
      child.setAttribute('inert', '');
      made.push(child);
    }
    return () => { for (const el of made) el.removeAttribute('inert'); };
  }, [present]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const target = initialFocusRef?.current ?? (initialFocus === 'dialog' ? dialog : focusableIn(dialog)[0] ?? dialog);
    target.focus({ preventScroll: true });
  }, [initialFocusRef, initialFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (dismissOnEscape) onCloseRef.current();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const items = focusableIn(dialog);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    // While exiting, the layer is inert and click-through: nothing waits for the animation.
    <div ref={layerRef} className="kb-modal-layer" data-closing={!present || undefined}>
      <m.div
        className={`kb-scrim${scrim === 'strong' ? ' kb-scrim--strong' : ''}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: SPRING_LARGE }}
        exit={{ opacity: 0, transition: EXIT }}
        onMouseDown={() => { if (dismissOnScrim) onCloseRef.current(); }}
        data-testid={testId ? `${testId}-scrim` : undefined}
      />
      <m.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`kb-modal${className ? ` ${className}` : ''}`}
        data-testid={testId}
        data-pane={pane}
        onKeyDown={onKeyDown}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: SPRING_LARGE }}
        exit={{ opacity: 0, scale: 0.98, transition: EXIT }}
      >
        {bare ? (
          <h2 id={titleId} className="kb-visually-hidden">{title}</h2>
        ) : (
          <header className="kb-modal__head">
            <h2 id={titleId} className="kb-modal__title">{title}</h2>
            <IconButton icon="close" label="Close" onClick={() => onCloseRef.current()} />
          </header>
        )}
        {children}
      </m.div>
    </div>
  );
}
