import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { noteName } from '../../state/noteTabs';
import type { Note } from '../../api/types';

interface Props {
  /** Notes of the session selected in the sidebar — the only ones this pane shows. */
  notes: Note[];
  onClose: () => void;
  onPick: (note: Note) => void;
}

/**
 * Pick a note of the current session to open in a tab.
 *
 * Only this session's notes are listed (docs/NOTES-POLISH-SPEC.md §3): the Notes
 * pane always belongs to the session selected on the left, so a note of another
 * lecture is reached by selecting that lecture, not by pulling it in here.
 */
export function OpenNoteDialog({ notes, onClose, onPick }: Props) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter((note) => noteName(note).toLowerCase().includes(needle));
  }, [notes, query]);

  // Modal = application level (PANES-SPEC §1): rendered at <body> so no
  // column's clipping or containment can capture it.
  return createPortal(
    <div className="modal" role="dialog" aria-modal="true" aria-label="Open notes">
      <div className="modal__card note-picker">
        <input
          className="note-picker__search"
          aria-label="Search notes"
          placeholder="Search notes"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        {visible.length === 0 && (
          <p className="note-picker__empty">
            {notes.length === 0 ? 'This recording has no notes yet.' : 'Nothing found.'}
          </p>
        )}
        <ul className="note-picker__list">
          {visible.map((note) => (
            <li key={note.id}>
              <button type="button" onClick={() => onPick(note)}>
                <span className="note-picker__title">{noteName(note)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="note-picker__foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
