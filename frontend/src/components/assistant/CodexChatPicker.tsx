import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { isActive, type CodexChat, type CodexScope, type CodexTask } from '../../api/codex';
import { Icon } from '../ui/Icon';
import { ContextMenu, ContextMenuItem } from '../ui/ContextMenu';
import { AnchoredPopover, isInside } from '../ui/AnchoredPopover';
import { SessionDialog } from '../sessions/SessionOverlays';
import { byActivity } from '../../state/codex';
import { SCOPE_HINT, SCOPE_LABEL } from './codexLabels';

interface Props {
  chats: CodexChat[];
  selected: CodexChat | null;
  tasks: CodexTask[];
  disabled: boolean;
  onSelect: (chatId: string) => void;
  onCreate: (scope: CodexScope) => void;
  onRename: (chatId: string, title: string) => void;
  onDelete: (chatId: string) => Promise<boolean>;
}

const SCOPES: CodexScope[] = ['session', 'group', 'all'];

/**
 * The chat title in the Assistant header opens this list — no permanent side
 * panel. "New chat" first (with its scope, fixed for the chat's lifetime),
 * then chats by last activity. A running chat shows a live dot, a finished
 * answer not yet seen shows a mark.
 */
export function CodexChatPicker({ chats, selected, tasks, disabled, onSelect, onCreate, onRename, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ chat: CodexChat; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [deleting, setDeleting] = useState<CodexChat | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      if (e.button === 2 || menu) return;
      if (!isInside(e.target, ref, popover)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !menu && !renaming) setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open, menu, renaming]);

  const running = (chatId: string) => tasks.some((t) => t.chat_id === chatId && isActive(t));
  const commitRename = () => {
    if (!renaming) return;
    const title = renaming.draft.trim();
    const chat = chats.find((c) => c.id === renaming.id);
    if (title && chat && title !== chat.title) onRename(renaming.id, title);
    setRenaming(null);
  };

  return (
    <div className="codex-picker" ref={ref}>
      <button ref={trigger} type="button" className="codex-picker__trigger" aria-haspopup="true" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen((v) => !v)} title={selected?.title}>
        <span className="codex-picker__title">{selected ? selected.title || 'Untitled' : 'New chat'}</span>
        <Icon name="chevron" size={12} className="codex-picker__chevron" />
      </button>

      {open && (
        <AnchoredPopover ref={popover} anchorRef={trigger} className="codex-picker__popover" role="dialog" aria-label="Chats">
          <div className="codex-picker__new">
            <strong>New chat</strong>
            <small>The scope is fixed per chat. A new chat does not see other chats’ history.</small>
            <div className="assistant__scopes" role="group" aria-label="New chat scope">
              {SCOPES.map((scope) => (
                <button key={scope} type="button" className="chip" title={SCOPE_HINT[scope]}
                  onClick={() => { setOpen(false); onCreate(scope); }}>
                  {SCOPE_LABEL[scope]}
                </button>
              ))}
            </div>
          </div>
          {chats.length > 0 && (
            <ul className="codex-picker__list" aria-label="Session chats">
              {byActivity(chats).map((chat) => (
                <li key={chat.id}
                  className={clsx('codex-picker__item', chat.id === selected?.id && 'codex-picker__item--on')}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ chat, x: e.clientX, y: e.clientY }); }}>
                  {renaming?.id === chat.id ? (
                    <input className="codex-picker__rename" aria-label="Chat name" autoFocus
                      value={renaming.draft}
                      onChange={(e) => setRenaming({ id: chat.id, draft: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); }
                      }} />
                  ) : (
                    <button type="button" className="codex-picker__select" aria-current={chat.id === selected?.id}
                      onClick={() => { setOpen(false); onSelect(chat.id); }}>
                      <span className="codex-picker__name">{chat.title || 'Untitled'}</span>
                      <small>{SCOPE_LABEL[chat.scope]}{chat.revoked ? ' · access revoked' : ''}</small>
                      {running(chat.id)
                        ? <span className="codex-task__dot codex-task__dot--live" aria-label="Running" />
                        : chat.unread && <span className="codex-picker__unread" aria-label="New answer" />}
                    </button>
                  )}
                  <button type="button" className="codex-picker__more" aria-label={`Actions for chat ${chat.title}`}
                    onClick={(e) => {
                      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setMenu({ chat, x: box.left, y: box.bottom });
                    }}>
                    <Icon name="more" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </AnchoredPopover>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label="Chat actions" onDismiss={() => setMenu(null)}>
          <ContextMenuItem onClick={() => { setRenaming({ id: menu.chat.id, draft: menu.chat.title }); setMenu(null); }}>
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={() => { setDeleting(menu.chat); setMenu(null); }}>Delete</ContextMenuItem>
        </ContextMenu>
      )}

      {deleting && (
        <SessionDialog title="Delete chat permanently?" busy={deleteBusy} onClose={() => setDeleting(null)}>
          <p>
            The history of chat “{deleting.title || 'Untitled'}” will be deleted and cannot be restored.
            {running(deleting.id) ? ' The running task of this chat will be stopped.' : ''} Recordings and Notes are not affected.
          </p>
          <div className="session-dialog__actions">
            <button className="btn btn--quiet" disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</button>
            <button className="btn btn--primary" disabled={deleteBusy} onClick={() => {
              setDeleteBusy(true);
              void onDelete(deleting.id).then((ok) => { if (ok) setDeleting(null); })
                .finally(() => setDeleteBusy(false));
            }}>Delete permanently</button>
          </div>
        </SessionDialog>
      )}
    </div>
  );
}
