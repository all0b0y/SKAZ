import { forwardRef, useLayoutEffect, useRef } from 'react';
import { Button } from '../../ui';

export interface ChatTabsEmptyStateProps {
  canReopen: boolean;
  lastClosedTitle?: string | null;
  onReopenLast: () => void;
  onNewChat?: () => void;
  sidebarHidden?: boolean;
  autoFocusReopen?: boolean;
  className?: string;
}

/**
 * Empty centre state shown after closing the last open chat tab.
 * Keeps `Reopen last chat` directly available even when the left sidebar is hidden.
 */
export const ChatTabsEmptyState = forwardRef<HTMLButtonElement, ChatTabsEmptyStateProps>(
  function ChatTabsEmptyState(
    { canReopen, lastClosedTitle, onReopenLast, onNewChat, sidebarHidden = false, autoFocusReopen = false, className },
    forwardedRef,
  ) {
    const innerRef = useRef<HTMLButtonElement | null>(null);

    useLayoutEffect(() => {
      if (autoFocusReopen && canReopen) {
        innerRef.current?.focus({ preventScroll: true });
      }
    }, [autoFocusReopen, canReopen]);

    const setRefs = (el: HTMLButtonElement | null) => {
      innerRef.current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef) forwardedRef.current = el;
    };

    return (
      <div
        className={`kb-chattabs-empty${className ? ` ${className}` : ''}`}
        role="region"
        aria-label="No open chats"
        data-testid="chat-tabs-empty"
      >
        <h2 className="kb-chattabs-empty__title">No open chats</h2>
        <p className="kb-chattabs-empty__text">
          {sidebarHidden
            ? 'Your conversations are still saved. Reopen the last chat or show the side panel to pick another.'
            : 'Your conversations are still saved. Choose one on the left to reopen it.'}
        </p>
        <div className="kb-chattabs-empty__actions">
          {canReopen && (
            <Button
              ref={setRefs}
              variant="outline"
              title={lastClosedTitle ? `Reopen “${lastClosedTitle}”` : 'Reopen last chat'}
              onClick={onReopenLast}
            >
              Reopen last chat
            </Button>
          )}
          {onNewChat && (
            <Button variant="fill" icon="newChat" onClick={onNewChat}>
              New chat
            </Button>
          )}
        </div>
      </div>
    );
  },
);
