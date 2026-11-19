import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, IconButton, Menu, type MenuItem } from '../../ui';

export interface ChatTabItem {
  id: string;
  title: string;
  /** True while the backend is actively streaming/answering this chat. */
  working?: boolean;
  /** True while a permission or question waits for the user. */
  waiting?: boolean;
  /** True when the chat has an unread answer. */
  unread?: boolean;
  pinned?: boolean;
}

export interface TabOverflowState {
  overflowing: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

export interface ChatTabStripProps {
  tabs: readonly ChatTabItem[];
  activeId: string | null;
  onSelect: (chatId: string) => void;
  onClose: (chatId: string) => void;
  /** Called after closing the last tab so the host can focus Reopen last chat. */
  onEmptyFocus?: () => void;
  emptyLabel?: string;
  overflowMenuLabel?: string;
  className?: string;
  /** Optional external focus request (e.g. after Reopen last chat). */
  focusTabId?: string | null;
  focusSeq?: number;
}

export function measureTabOverflow(track: Pick<HTMLElement, 'scrollWidth' | 'clientWidth' | 'scrollLeft'> | null): TabOverflowState {
  if (!track) return { overflowing: false, canScrollLeft: false, canScrollRight: false };
  const overflowing = track.scrollWidth > track.clientWidth + 1;
  if (!overflowing) return { overflowing: false, canScrollLeft: false, canScrollRight: false };
  return {
    overflowing: true,
    canScrollLeft: track.scrollLeft > 1,
    canScrollRight: track.scrollLeft + track.clientWidth < track.scrollWidth - 1,
  };
}

export function ensureTabVisible(
  track: Pick<HTMLElement, 'scrollWidth' | 'clientWidth' | 'scrollLeft'> | null,
  item: Pick<HTMLElement, 'offsetLeft' | 'offsetWidth'> & Partial<Pick<HTMLElement, 'scrollIntoView'>> | null,
): boolean {
  if (!track || !item) return false;
  if (track.scrollWidth > track.clientWidth + 1 && item.offsetWidth > 0) {
    const left = item.offsetLeft;
    const right = left + item.offsetWidth;
    if (left < track.scrollLeft) {
      track.scrollLeft = left;
      return true;
    }
    if (right > track.scrollLeft + track.clientWidth) {
      track.scrollLeft = Math.max(0, right - track.clientWidth);
      return true;
    }
    return false;
  }
  item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return false;
}

function statusNote(tab: ChatTabItem, isActive: boolean): string | undefined {
  if (tab.waiting) return 'Waiting';
  if (tab.working) return 'Working';
  if (tab.unread && !isActive) return 'New';
  return undefined;
}

/**
 * Single-row closable chat tab strip for the chat header (46 px height preserved).
 * Supports roving tabindex, ArrowLeft/ArrowRight/Home/End navigation, permanently visible
 * non-nested close buttons, background working indicators, and real horizontal overflow.
 */
export function ChatTabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onEmptyFocus,
  emptyLabel = 'No open chats',
  overflowMenuLabel = 'Open tabs',
  className,
  focusTabId,
  focusSeq = 0,
}: ChatTabStripProps) {
  const baseId = useId();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const overflowBtnRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusRef = useRef<{ id: string | null; empty: boolean } | null>(null);
  const revealed = useRef<{ id: string; left: number } | null>(null);

  const [overflow, setOverflow] = useState<TabOverflowState>({
    overflowing: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const [menuOpen, setMenuOpen] = useState(false);

  const syncOverflow = useCallback(() => {
    const next = measureTabOverflow(trackRef.current);
    setOverflow((prev) =>
      prev.overflowing === next.overflowing &&
      prev.canScrollLeft === next.canScrollLeft &&
      prev.canScrollRight === next.canScrollRight
        ? prev
        : next,
    );
  }, []);

  const reveal = useCallback((id: string) => {
    const track = trackRef.current;
    const item = itemRefs.current.get(id);
    if (!track || !item) return;
    ensureTabVisible(track, item);
    revealed.current = { id, left: track.scrollLeft };
  }, []);

  useLayoutEffect(() => {
    if (activeId) reveal(activeId);
    else revealed.current = null;
  }, [activeId, reveal]);

  useLayoutEffect(syncOverflow, [tabs, activeId, syncOverflow]);

  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    if (pending.empty) {
      // Run after commitLayoutEffects finishes so a newly mounted sibling empty state has attached its ref.
      queueMicrotask(() => onEmptyFocus?.());
      return;
    }
    if (pending.id) {
      const btn = tabRefs.current.get(pending.id);
      if (btn) {
        reveal(pending.id);
        btn.focus({ preventScroll: true });
      }
    }
  }, [tabs, menuOpen, onEmptyFocus, reveal]);

  useLayoutEffect(() => {
    if (!focusSeq || !focusTabId) return;
    const btn = tabRefs.current.get(focusTabId);
    if (btn) {
      reveal(focusTabId);
      btn.focus({ preventScroll: true });
    }
  }, [focusSeq, focusTabId, reveal]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      // The header may shrink as its controls mount. Finish revealing the selection only while
      // the track remains where selection/focus put it; manual browsing owns its new position.
      const last = revealed.current;
      if (last && track.scrollLeft === last.left) reveal(last.id);
      syncOverflow();
    });
    ro?.observe(track);
    return () => ro?.disconnect();
  }, [tabs.length, syncOverflow, reveal]);

  useEffect(() => {
    if (!overflow.overflowing && menuOpen) setMenuOpen(false);
  }, [overflow.overflowing, menuOpen]);

  const scrollByStep = (dir: -1 | 1) => {
    const track = trackRef.current;
    if (!track) return;
    const step = Math.max(140, Math.floor(track.clientWidth * 0.6));
    const max = Math.max(0, track.scrollWidth - track.clientWidth);
    track.scrollLeft = Math.max(0, Math.min(max, track.scrollLeft + dir * step));
    syncOverflow();
  };

  const handleTabKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    if (tabs.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const target = tabs[nextIndex];
    if (!target) return;
    onSelect(target.id);
    reveal(target.id);
    tabRefs.current.get(target.id)?.focus({ preventScroll: true });
  };

  const handleCloseClick = (index: number, chatId: string) => {
    const nextFocusId = tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
    pendingFocusRef.current = nextFocusId ? { id: nextFocusId, empty: false } : { id: null, empty: true };
    onClose(chatId);
  };

  const hasActiveInTabs = activeId !== null && tabs.some((t) => t.id === activeId);

  const menuItems: MenuItem[] = tabs.map((tab) => {
    const isActive = tab.id === activeId;
    return {
      id: tab.id,
      label: tab.title,
      icon: isActive ? 'check' : tab.pinned ? 'pin' : 'chats',
      note: statusNote(tab, isActive),
      onSelect: () => {
        pendingFocusRef.current = { id: tab.id, empty: false };
        onSelect(tab.id);
      },
    };
  });

  if (tabs.length === 0) {
    return (
      <div className={`kb-chattabs${className ? ` ${className}` : ''}`} data-testid="chat-tab-strip">
        <span className="kb-chattabs__empty" role="status">
          {emptyLabel}
        </span>
      </div>
    );
  }

  return (
    <div className={`kb-chattabs${className ? ` ${className}` : ''}`} data-testid="chat-tab-strip">
      <div
        ref={trackRef}
        className="kb-chattabs__track"
        role="tablist"
        aria-label="Open chats"
        onScroll={(event) => {
          if (revealed.current?.left !== event.currentTarget.scrollLeft) revealed.current = null;
          syncOverflow();
        }}
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeId;
          const tabIndex = isActive || (!hasActiveInTabs && index === 0) ? 0 : -1;
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) itemRefs.current.set(tab.id, el);
                else itemRefs.current.delete(tab.id);
              }}
              className="kb-chattabs__item"
              role="presentation"
              data-active={isActive ? 'true' : 'false'}
              data-chat-id={tab.id}
              onFocus={() => reveal(tab.id)}
            >
              <button
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                id={`${baseId}-tab-${tab.id}`}
                type="button"
                role="tab"
                className="kb-chattabs__tab"
                aria-selected={isActive}
                tabIndex={tabIndex}
                title={tab.title}
                onClick={() => {
                  reveal(tab.id);
                  onSelect(tab.id);
                  tabRefs.current.get(tab.id)?.focus({ preventScroll: true });
                }}
                onKeyDown={(e) => handleTabKeyDown(index, e)}
              >
                <span className="kb-chattabs__title">{tab.title}</span>
                {tab.waiting ? (
                  <i className="kb-chattabs__dot kb-chattabs__dot--waiting" aria-label="Waiting for you" />
                ) : tab.working ? (
                  <i className="kb-chattabs__dot kb-chattabs__dot--working" aria-label="Working" />
                ) : tab.unread && !isActive ? (
                  <i className="kb-chattabs__dot kb-chattabs__dot--unread" aria-label="New answer" />
                ) : null}
              </button>
              <button
                type="button"
                className="kb-chattabs__close"
                aria-label={`Close tab: ${tab.title}`}
                title="Close tab — chat stays in the list"
                onClick={() => handleCloseClick(index, tab.id)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {overflow.overflowing && (
        <div className="kb-chattabs__overflow" data-testid="chat-tabs-overflow">
          <IconButton
            icon="chevronLeft"
            label="Scroll tabs left"
            size="sm"
            disabled={!overflow.canScrollLeft}
            onClick={() => scrollByStep(-1)}
          />
          <IconButton
            icon="chevronRight"
            label="Scroll tabs right"
            size="sm"
            disabled={!overflow.canScrollRight}
            onClick={() => scrollByStep(1)}
          />
          <IconButton
            ref={overflowBtnRef}
            icon="chevronDown"
            label={overflowMenuLabel}
            size="sm"
            className="kb-chattabs__menu-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            badge={<span className="kb-chattabs__count" aria-hidden="true">{tabs.length}</span>}
            onClick={() => setMenuOpen((v) => !v)}
          />
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchorRef={overflowBtnRef}
            label={overflowMenuLabel}
            items={menuItems}
          />
        </div>
      )}
    </div>
  );
}
