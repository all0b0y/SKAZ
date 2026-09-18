import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { NoteDetail } from '../../api/types';
import type { SaveStatus } from '../../lib/autosave';
import type { NoteTab } from '../../state/noteTabs';
import { ContextMenu, ContextMenuItem } from '../ui/ContextMenu';
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
  onCreateEmpty: () => void;
  onCreateGenerated: () => void;
  onOpenExisting: () => void;
  onDetailChange: (detail: NoteDetail) => void;
}

const DETAIL_LABELS: Array<[NoteDetail, string]> = [
  ['brief', 'Тезисно'],
  ['normal', 'Обычно'],
  ['detailed', 'Подробно'],
];

const SAVE_LABELS: Record<SaveStatus, string> = {
  saved: 'Сохранено',
  dirty: 'Не сохранено',
  saving: 'Сохранение…',
  error: 'Не удалось сохранить',
};

function useDismiss(onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: MouseEvent) => {
      // A right click asks for a context menu elsewhere; that menu will close
      // this one through the window's single-menu register, and treating the
      // press itself as a dismissal would eat the click that opens it.
      if (event.button === 2) return;
      if (!ref.current?.contains(event.target as Node)) onDismiss();
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
 * The "+" and its menu live OUTSIDE the tab strip on purpose. The strip scrolls
 * horizontally, and an `overflow-x: auto` box clips in both axes — a dropdown
 * anchored inside it was rendered and then cut away, so the button looked dead.
 * The tab's own menu sidesteps that differently: it is fixed to the viewport at
 * the pointer.
 *
 * Detail belongs to the "+" menu, where a note is started: it is a parameter of
 * writing one, not a setting of the panel. Regeneration is not in this strip at
 * all — it acts on a selected passage, so it lives in the menu over the text.
 */
export function NoteTabsBar({
  tabs, activeTabId, detail, canGenerate, generateHint, generating, saveStatus,
  onSelect, onClose, onRename, onDelete,
  onCreateEmpty, onCreateGenerated, onOpenExisting, onDetailChange,
}: Props) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tab: NoteTab; x: number; y: number } | null>(null);
  const container = useDismiss(() => setMenu(false));

  return (
    <div className="note-tabs" ref={container}>
      <div className="note-tabs__strip" role="tablist" aria-label="Открытые конспекты">
        {tabs.map((tab) => {
          const name = tab.title || 'Без названия';
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
                  onClick={() => onSelect(tab.id)}
                >
                  {name}
                </button>
              )}
              <button
                type="button"
                className="note-tab__close"
                aria-label={`Закрыть ${name}`}
                onClick={() => onClose(tab.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {/* A tab whose generation has not produced a note yet names and deletes
          nothing: there is no stored document behind it to act on. Both entries
          stay visible and say so, rather than leaving an empty menu. */}
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          label={`Конспект «${tabMenu.tab.title || 'Без названия'}»`}
          onDismiss={() => setTabMenu(null)}
        >
          <ContextMenuItem
            disabled={tabMenu.tab.noteId === null}
            hint="Конспект ещё не создан"
            onClick={() => {
              setRenaming(tabMenu.tab.id);
              setTabMenu(null);
            }}
          >
            Переименовать
          </ContextMenuItem>
          <ContextMenuItem
            disabled={tabMenu.tab.noteId === null}
            hint="Конспект ещё не создан"
            onClick={() => {
              onDelete(tabMenu.tab);
              setTabMenu(null);
            }}
          >
            Удалить
          </ContextMenuItem>
        </ContextMenu>
      )}

      <div className="note-tabs__menu-anchor">
        <button
          type="button"
          className="note-tabs__add"
          aria-label="Новый конспект"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          +
        </button>
        {menu && (
          <div className="note-menu" role="menu" aria-label="Новый конспект">
            <button
              type="button"
              role="menuitem"
              disabled={!canGenerate || generating}
              title={generateHint ?? undefined}
              onClick={() => { setMenu(false); onCreateGenerated(); }}
            >
              {generating ? 'Генерация…' : 'Создать конспект с ИИ'}
              {!canGenerate && generateHint && <small>{generateHint}</small>}
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onCreateEmpty(); }}>
              Создать пустой
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onOpenExisting(); }}>
              Открыть существующий
            </button>
            {/* How dense the next generated note should be. The menu stays open
                after a click: choosing a level prepares the generation above it
                rather than being an action of its own. */}
            <div className="note-menu__field">
              <span id="note-detail-label">Подробность</span>
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
          </div>
        )}
      </div>
    </div>
  );
}
