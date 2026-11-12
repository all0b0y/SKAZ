import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { KbChatSummary } from '../../api/kb/types.gen';
import type { ListSelection } from '../ui/listSelection';
import { Icon, Popover } from '../ui';
import { useChats, useServices } from '../state/context';
import { getResearchStore, useResearch } from './store';

/**
 * «+» menu in the Chats sidebar header (mockup v4 state 01, G1 choice 1 = B):
 * `New chat`, `<hr>` divider, `Research` section label, `New research task`.
 */
export function ChatsPlusMenu() {
  const { client, chats, ui } = useServices();
  const research = getResearchStore(client);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
    );
    if (items.length === 0) return;
    const currentIdx = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = items[(currentIdx + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(currentIdx - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    else if (event.key === 'Tab') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`kb-iconbtn kb-iconbtn--sm${open ? ' is-active' : ''}`}
        aria-label="New"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="chats-plus-button"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="plus" size={16} />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        label="New"
        role="menu"
        placement="bottom-end"
        className="kb-menu kb-newmenu"
        onKeyDown={handleKeyDown}
      >
        <div className="kb-menu__list">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="kb-menu__item"
            onClick={() => {
              setOpen(false);
              anchorRef.current?.focus({ preventScroll: true });
              research.getState().close();
              ui.getState().showCenter('chat');
              chats.getState().open(null);
            }}
          >
            <Icon name="chats" size={14} />
            <span className="kb-menu__label">New chat</span>
          </button>
          <hr className="kb-newmenu__sep" role="separator" />
          <div className="kb-newmenu__label" role="presentation">
            Research
          </div>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="kb-menu__item"
            onClick={() => {
              setOpen(false);
              anchorRef.current?.focus({ preventScroll: true });
              ui.getState().showCenter('chat');
              research.getState().openNewTask();
            }}
          >
            <Icon name="compass" size={14} />
            <span className="kb-menu__label">New research task</span>
          </button>
        </div>
      </Popover>
    </>
  );
}

/**
 * Optional sidebar section listing active/recent research tasks when present in the store.
 */
export function ResearchTaskListSection({ rows, renderRow, gridProps }: {
  rows: KbChatSummary[];
  renderRow: (chat: KbChatSummary) => ReactNode;
  gridProps: ListSelection['gridProps'];
}) {
  const { client, folds } = useServices();
  const research = getResearchStore(client);
  const mode = useResearch((s) => s.mode);
  const activeTaskId = useResearch((s) => s.activeTaskId);
  const folded = useStore(folds, (s) => s.isFolded('research-sidebar', false));
  const chatList = useChats((s) => s.list);
  useEffect(() => { void research.getState().loadTasks(); }, [research, chatList]);
  // A newly opened task must be visible even if this block was folded last time.
  useEffect(() => {
    if (mode === 'task' && activeTaskId) folds.getState().setFolded('research-sidebar', false);
  }, [mode, activeTaskId, folds]);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Research tasks">
      <button type="button" className="kb-subhead kb-research-disclosure" aria-expanded={!folded}
        onClick={() => folds.getState().setFolded('research-sidebar', !folded)}>
        <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={12} />
        <span className="kb-subhead__text">Research</span>
      </button>
      {!folded && <ul className="kb-list" {...gridProps} aria-label="Research tasks">{rows.map(renderRow)}</ul>}
    </section>
  );
}
