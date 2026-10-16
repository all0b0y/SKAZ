import { useEffect, useRef, useState, type RefObject } from 'react';
import { clsx } from 'clsx';
import type { NoteDetail } from '../../api/types';
import type { SaveStatus } from '../../lib/autosave';
import type { NoteTab } from '../../state/noteTabs';
import { ContextMenu, ContextMenuItem } from '../ui/ContextMenu';
import { AnchoredPopover, isInside } from '../ui/AnchoredPopover';
import { ScrollRow } from '../ui/ScrollRow';
import { NoteTitleInput } from './NoteTitleInput';

interface Props {
  tabs: NoteTab[];
  activeTabId: string | null;
  detail: NoteDetail;
  /** False while there is nothing to summarise, with the reason shown on the item. */
  canGenerate: boolean;
  generateHint: string | null;
  generating: boolean;
  /** Save state of the open document, or null when nothing is open. */
  saveStatus: SaveStatus | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** Decision 9: renaming is offered on the tab as well as in the list. */
  onRename: (tab: NoteTab, title: string) => void;
  /** Decision 14: deletion is offered from the tab as well as from the list. */
  onDelete: (tab: NoteTab) => void;
  /** Hand the tab's note to the system share sheet at the menu's position. */
  onShare: (tab: NoteTab, x: number, y: number) => void;
  /** Why sharing is impossible on this machine at all, or null when it works. */
  shareUnavailable: string | null;
  onCreateEmpty: () => void;
  onCreateGenerated: () => void;
  onOpenExisting: () => void;
  onDetailChange: (detail: NoteDetail) => void;
}

const DETAIL_LABELS: Array<[NoteDetail, string]> = [
  ['brief', 'Brief'],
  ['normal', 'Standard'],
  ['detailed', 'Detailed'],
];

const SAVE_LABELS: Record<SaveStatus, string> = {
  saved: 'Saved',
  dirty: 'Not saved',
  saving: 'Saving…',
  error: 'Could not save',
};

function useDismiss(onDismiss: () => void, popups: Array<RefObject<HTMLElement>>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: MouseEvent) => {
      // A right click asks for a context menu elsewhere; that menu will close
      // this one through the window's single-menu register, and treating the
      // press itself as a dismissal would eat the click that opens it.
      if (event.button === 2) return;
      // The dropdown is rendered at <body> (it must not be clipped by the strip),
      // so a press inside it is not "inside the bar" by DOM ancestry.
      if (!isInside(event.target, ref, ...popups)) onDismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [onDismiss]);
  return ref;
}

/**
 * The browser-style strip above the editor: one tab per open note, a "+" that
 * offers the ways to start one, and nothing else.
 *
 * A tab carries exactly one visible control — the close "×". Renaming and
 * deleting live behind a right click: a row of icons on every tab turned the
 * strip into a wall of buttons and put a destructive action one mis-click away
 * from the one that merely closes a document. A double click is not a second way
 * in either, because it fires while clicking quickly through tabs.
 *
 * The "+" lives OUTSIDE the tab strip, and both its dropdown and the tab's own
 * menu are rendered at <body> and placed inside the centre column
 * (.dev/docs/PANES-SPEC.md §1): the strip scrolls horizontally and would clip
 * anything anchored inside it, and neither menu may spill into the chat.
 *
 * Detail belongs to the "+" menu, where a note is started: it is a parameter of
 * writing one, not a setting of the panel. Regeneration is not in this strip at
 * all — it acts on a selected passage, so it lives in the menu over the text.
 */
export function NoteTabsBar({
  tabs, activeTabId, detail, canGenerate, generateHint, generating, saveStatus,
  onSelect, onClose, onRename, onDelete, onShare, shareUnavailable,
  onCreateEmpty, onCreateGenerated, onOpenExisting, onDetailChange,
}: Props) {
  const [menu, setMenu] = useState(false);
  // The "⋯" list of every open tab, offered only while some are scrolled away.
  const [list, setList] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // Picking from "⋯" reveals the tab even when it already was the active one.
  const [reveal, setReveal] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tab: NoteTab; x: number; y: number } | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listButton = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const container = useDismiss(() => { setMenu(false); setList(false); }, [menuRef, listRef]);

  return (
    <div className="note-tabs" ref={container}>
      <ScrollRow
        className="note-tabs__strip"
        role="tablist"
        aria-label="Open notes"
        activeKey={`${activeTabId}:${reveal}`}
        onOverflow={(edges) => setOverflowing(edges.start || edges.end)}
      >
        {tabs.map((tab) => {
          const name = tab.title || 'Untitled';
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={clsx('note-tab', active && 'note-tab--on')}
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenu({ tab, x: event.clientX, y: event.clientY });
              }}
            >
              {/* The save state on the document's own tab. One dot, for the note
                  actually on screen: nothing tracks the state of a background
                  tab, and a row of dots would imply otherwise. */}
              {active && saveStatus && (
                <span
                  className="note-tab__save"
                  data-status={saveStatus}
                  role="status"
                  aria-label={SAVE_LABELS[saveStatus]}
                  title={SAVE_LABELS[saveStatus]}
                />
              )}
              {renaming === tab.id ? (
                <NoteTitleInput
                  value={tab.title}
                  onCommit={(title) => {
                    setRenaming(null);
                    onRename(tab, title);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="note-tab__label"
                  title={name}
                  onClick={() => onSelect(tab.id)}
                >
                  {name}
                </button>
              )}
              <button
                type="button"
                className="note-tab__close"
                aria-label={`Close ${name}`}
                onClick={() => onClose(tab.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </ScrollRow>

      {/* A tab whose generation has not produced a note yet names and deletes
          nothing: there is no stored document behind it to act on. Both entries
          stay visible and say so, rather than leaving an empty menu. */}
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          label={`Notes “${tabMenu.tab.title || 'Untitled'}”`}
          onDismiss={() => setTabMenu(null)}
        >
          {/* Sends the note as a file through the system share sheet (spec §6). */}
          <ContextMenuItem
            disabled={tabMenu.tab.noteId === null || shareUnavailable !== null}
            hint={shareUnavailable ?? 'The notes are not created yet'}
            onClick={() => {
              onShare(tabMenu.tab, tabMenu.x, tabMenu.y);
              setTabMenu(null);
            }}
          >
            Share…
          </ContextMenuItem>
          <ContextMenuItem
            disabled={tabMenu.tab.noteId === null}
            hint="The notes are not created yet"
            onClick={() => {
              setRenaming(tabMenu.tab.id);
              setTabMenu(null);
            }}
          >
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            disabled={tabMenu.tab.noteId === null}
            hint="The notes are not created yet"
            onClick={() => {
              onDelete(tabMenu.tab);
              setTabMenu(null);
            }}
          >
            Delete
          </ContextMenuItem>
        </ContextMenu>
      )}

      <div className="note-tabs__menu-anchor">
        {overflowing && (
          <button
            ref={listButton}
            type="button"
            className="note-tabs__add note-tabs__list"
            aria-label="All open notes"
            title="All open notes"
            aria-haspopup="menu"
            aria-expanded={list}
            onClick={() => { setMenu(false); setList(!list); }}
          >
            ⋯
          </button>
        )}
        {list && overflowing && (
          <AnchoredPopover ref={listRef} anchorRef={listButton} align="end"
            className="note-menu note-menu--list" role="menu" aria-label="All open notes">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="menuitemradio"
                aria-checked={tab.id === activeTabId}
                className={clsx(tab.id === activeTabId && 'note-menu__item--on')}
                onClick={() => { setList(false); onSelect(tab.id); setReveal((n) => n + 1); }}
              >
                {tab.title || 'Untitled'}
              </button>
            ))}
          </AnchoredPopover>
        )}
        <button
          ref={addRef}
          type="button"
          className="note-tabs__add"
          aria-label="New notes"
          aria-expanded={menu}
          onClick={() => { setList(false); setMenu(!menu); }}
        >
          +
        </button>
        {menu && (
          <AnchoredPopover ref={menuRef} anchorRef={addRef} align="end"
            className="note-menu" role="menu" aria-label="New notes">
            <button
              type="button"
              role="menuitem"
              disabled={!canGenerate || generating}
              title={generateHint ?? undefined}
              onClick={() => { setMenu(false); onCreateGenerated(); }}
            >
              {generating ? 'Generating…' : 'Create AI notes'}
              {!canGenerate && generateHint && <small>{generateHint}</small>}
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onCreateEmpty(); }}>
              Create empty
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onOpenExisting(); }}>
              Open existing
            </button>
            {/* How dense the next generated note should be. The menu stays open
                after a click: choosing a level prepares the generation above it
                rather than being an action of its own. */}
            <div className="note-menu__field">
              <span id="note-detail-label">Detail</span>
              <div className="note-detail" role="radiogroup" aria-labelledby="note-detail-label">
                {DETAIL_LABELS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={detail === value}
                    className={clsx('note-detail__step', detail === value && 'note-detail__step--on')}
                    onClick={() => onDetailChange(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </AnchoredPopover>
        )}
      </div>
    </div>
  );
}
