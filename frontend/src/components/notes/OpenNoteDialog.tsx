import { useEffect, useMemo, useState } from 'react';
import { ApiClient } from '../../api/client';
import { useStore } from '../../state/store';
import { stripTags } from '../../lib/sessionTags';
import { titleFromContent } from '../../state/noteTabs';
import type { Note } from '../../api/types';

interface Props {
  onClose: () => void;
  onPick: (sessionId: string, note: Note) => void;
}

interface Row {
  sessionId: string;
  sessionTitle: string;
  note: Note;
}

/**
 * Pick any note of any session to open in a new tab.
 *
 * Notes of other sessions are listed too, because a user reasonably wants two
 * lectures side by side. The session each note belongs to is always shown and
 * always travels with the tab, so opening one can never quietly re-point its
 * citations at whichever session happens to be selected in the sidebar.
 */
export function OpenNoteDialog({ onClose, onPick }: Props) {
  const sessions = useStore((s) => s.sessions);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let disposed = false;
    const api = new ApiClient(window.audiohelper);
    void (async () => {
      try {
        const collected: Row[] = [];
        for (const session of sessions) {
          const { notes } = await api.listNotes(session.id);
          for (const note of notes) {
            collected.push({ sessionId: session.id, sessionTitle: stripTags(session.title), note });
          }
        }
        if (!disposed) setRows(collected);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { disposed = true; };
  }, [sessions]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows ?? [];
    return (rows ?? []).filter((row) =>
      titleFromContent(row.note.content).toLowerCase().includes(needle)
      || row.sessionTitle.toLowerCase().includes(needle));
  }, [rows, query]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Открыть конспект">
      <div className="modal__card note-picker">
        <input
          className="note-picker__search"
          aria-label="Поиск по конспектам"
          placeholder="Поиск по конспектам и сессиям"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        {error && <p role="alert" className="notes__error">{error}</p>}
        {rows === null && !error && <p className="loading">Загрузка…</p>}
        {rows !== null && visible.length === 0 && <p className="note-picker__empty">Ничего не найдено.</p>}
        <ul className="note-picker__list">
          {visible.map((row) => (
            <li key={`${row.sessionId}:${row.note.id}`}>
              <button type="button" onClick={() => onPick(row.sessionId, row.note)}>
                <span className="note-picker__title">
                  {titleFromContent(row.note.content) || 'Без названия'}
                </span>
                <span className="note-picker__session">{row.sessionTitle}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="note-picker__foot">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}
