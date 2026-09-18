import { useEffect, useRef, useState } from 'react';
import type { Note } from '../../api/types';
import { noteName } from '../../state/noteTabs';
import { Icon } from '../ui/Icon';
import { NoteTitleInput } from './NoteTitleInput';

interface Props {
  notes: Note[];
  onOpen: (note: Note) => void;
  onRename: (note: Note, title: string) => void;
  onDelete: (note: Note) => void;
}

/**
 * How long a click waits to see whether a second one follows.
 *
 * A row is both "open me" and "rename me", so the first click cannot act at
 * once: opening the note unmounts this list, and the second click of a rename
 * would land on the editor behind it. This is the price of decision 9 (rename by
 * double click) on a list that also opens by single click.
 */
const DOUBLE_CLICK_MS = 250;

/**
 * Rows per page.
 *
 * The list sits above the two start buttons, so an unbounded list pushes them out
 * of reach on a session with a term's worth of notes. A fixed page keeps the pane
 * a fixed height and the controls where the user last saw them.
 */
export const NOTES_PER_PAGE = 5;

/**
 * The notes already in this session, shown instead of an empty state.
 *
 * A user who wrote notes yesterday must see them on arrival, not guess that they
 * live behind a "+" menu. Nothing opens by itself, though: closing a tab is a
 * deliberate act, and returning to this screen must not quietly undo it.
 */
export function NoteList({ notes, onOpen, onRename, onDelete }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pendingOpen = useRef<number | null>(null);

  const pages = Math.max(1, Math.ceil(notes.length / NOTES_PER_PAGE));
  // Deleting the last note of the final page must not strand the user on a page
  // that no longer exists — they would see an empty list and no reason for it.
  const current = Math.min(page, pages - 1);
  useEffect(() => {
    if (page !== current) setPage(current);
  }, [page, current]);

  const visible = notes.slice(current * NOTES_PER_PAGE, current * NOTES_PER_PAGE + NOTES_PER_PAGE);

  const cancelPendingOpen = () => {
    if (pendingOpen.current !== null) {
      window.clearTimeout(pendingOpen.current);
      pendingOpen.current = null;
    }
  };

  // An unmount mid-wait must not fire an open into a component that is gone.
  useEffect(() => cancelPendingOpen, []);

  if (notes.length === 0) return null;

  return (
    <div className="note-list-block">
      <ul className="note-list" aria-label="Конспекты сессии">
        {visible.map((note) => {
          const name = noteName(note);
          return (
            <li key={note.id} className="note-list__row">
              {renaming === note.id ? (
                <NoteTitleInput
                  value={note.title?.trim() ?? ''}
                  onCommit={(title) => {
                    setRenaming(null);
                    onRename(note, title);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <button
                  type="button"
                  className="note-list__open"
                  aria-label={`Открыть ${name}`}
                  onClick={() => {
                    cancelPendingOpen();
                    pendingOpen.current = window.setTimeout(() => {
                      pendingOpen.current = null;
                      onOpen(note);
                    }, DOUBLE_CLICK_MS);
                  }}
                  onDoubleClick={() => {
                    cancelPendingOpen();
                    setRenaming(note.id ?? null);
                  }}
                >
                  <span className="note-list__title">{name}</span>
                  <span className="note-list__meta">{editedAt(note)}</span>
                </button>
              )}
              <button
                type="button"
                className="note-list__delete"
                aria-label={`Удалить ${name}`}
                title="Удалить конспект"
                onClick={() => {
                  cancelPendingOpen();
                  onDelete(note);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </li>
          );
        })}
      </ul>

      {/* One page has nothing to page through, so the controls stay away rather
          than sitting there permanently disabled. */}
      {pages > 1 && (
        <nav className="note-list__pager" aria-label="Страницы конспектов">
          <button
            type="button"
            className="note-list__page-btn"
            aria-label="Предыдущая страница"
            disabled={current === 0}
            onClick={() => {
              cancelPendingOpen();
              setPage(current - 1);
            }}
          >
            ‹
          </button>
          <span className="note-list__page-count">{current + 1} из {pages}</span>
          <button
            type="button"
            className="note-list__page-btn"
            aria-label="Следующая страница"
            disabled={current >= pages - 1}
            onClick={() => {
              cancelPendingOpen();
              setPage(current + 1);
            }}
          >
            ›
          </button>
        </nav>
      )}
    </div>
  );
}

/** When the user last touched it, in words rather than a raw timestamp. */
function editedAt(note: Note): string {
  const stamp = note.updated_at || note.created_at;
  const moment = new Date(stamp);
  if (Number.isNaN(moment.getTime())) return '';
  const minutes = Math.floor((Date.now() - moment.getTime()) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return moment.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
