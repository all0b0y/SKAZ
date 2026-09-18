import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ApiClient } from '../../api/client';
import type { Note } from '../../api/types';
import { Autosave, type SaveStatus } from '../../lib/autosave';
import { highlightCitedText } from '../../lib/citationHighlight';
import { blockRangeOf, resolveSelectionSpan, type SourceSpan } from '../../lib/noteSelection';
import { markSourceOffsets } from '../../lib/sourceOffsets';
import { Icon } from '../ui/Icon';

/** What the user pointed at: the text, and where it lives in the stored Markdown. */
export interface EditorSelection {
  text: string;
  /** Null when the text cannot be located character-for-character in the source. */
  span: SourceSpan | null;
  x: number;
  y: number;
}

interface Props {
  sessionId: string;
  note: Note;
  /** Reports every accepted write, so the tab can rename itself from the heading. */
  onSaved: (note: Note) => void;
  /** Lifted so the quiet save dot can live in the tab strip, above the document. */
  onStatusChange?: (status: SaveStatus, message: string | null) => void;
  /** A right click on the document, with the selection it was made over. */
  onContextMenu?: (selection: EditorSelection) => void;
}

// Note content is generated from an untrusted audio transcript (see AGENTS.md:
// transcript text is data, never instructions). react-markdown escapes raw HTML
// by default and rehype-raw is deliberately not wired in, so embedded
// <script>/<img onerror> can never execute — they stay inert text.
const isSafeExternalUrl = (href?: string): boolean => (
  typeof href === 'string' && /^https?:\/\//i.test(href.trim())
);

const markdownComponents: Components = {
  // Only genuine http(s) links become clickable, and always outside the app
  // window rather than navigating this renderer away from itself. Anything else
  // (javascript:, data:, stray relative paths) renders as plain inert text.
  a: ({ href, children }) => (
    isSafeExternalUrl(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <>{children}</>
  ),
};

/**
 * The note as a document: formatted Markdown at rest, raw Markdown while editing.
 *
 * Reading a note must not show `##` and `**` — that is source, not a note. So the
 * stored Markdown is rendered, and editing is entered deliberately, through the
 * pencil resting in the sheet's corner. A click in the text does NOT enter it:
 * any stray click used to turn the page into source, and it stole the clicks that
 * belong to selecting a sentence, following a link, or raising the app's menu on
 * it. The pencil becomes a check while editing, and that check, a click outside
 * the sheet, or Escape all leave — saving, never discarding.
 *
 * Saving is never the user's job. With note versions gone, losing text is
 * unrecoverable, so the editor writes on idle and on unmount — a tab close, a
 * session change or a quit. The dot in the tab strip only reports that state.
 * Nothing here can throw text away, which is why leaving always saves.
 */
export function NoteEditor({ sessionId, note, onSaved, onStatusChange, onContextMenu }: Props) {
  const [draft, setDraft] = useState(note.content);
  // A note with nothing in it opens ready to type: there is no document to read,
  // and sending the user to look for the pencil first is a step for nothing.
  const [editing, setEditing] = useState(() => !note.content.trim());
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  // The revision moves with every accepted write, so the next save carries the
  // right expectation and a stale one is rejected instead of clobbering.
  const current = useRef(note);
  const report = useRef(onStatusChange);
  report.current = onStatusChange;

  const autosave = useMemo(() => new Autosave({
    save: async (content) => {
      const saved = await new ApiClient(window.audiohelper).editNote(sessionId, current.current, content);
      current.current = saved;
      onSaved(saved);
    },
    onStatus: (next, message) => {
      const detail = next === 'error' ? (message ?? 'Не удалось сохранить') : null;
      setError(detail);
      report.current?.(next, detail);
    },
  // A different note is a different document: it gets its own autosave rather
  // than one still holding the previous note's pending text.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sessionId, note.id]);

  useEffect(() => {
    setDraft(note.content);
    current.current = note;
    setEditing(!note.content.trim());
    setError(null);
    report.current?.('saved', null);
  // Only when the document itself changes; re-running on every content update
  // would overwrite what the user is typing right now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(() => () => {
    void autosave.flush().finally(() => autosave.dispose());
  }, [autosave]);

  // Entered without a click in the text, so the caret has to be placed: the end
  // is where a note is continued. The view is left where the user was reading —
  // scrolling them elsewhere the moment they press the pencil loses their place.
  useEffect(() => {
    const field = textarea.current;
    if (!editing || !field) return;
    const top = field.scrollTop;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
    field.scrollTop = top;
  }, [editing]);

  /** Leave editing. Always writes: there are no versions to restore a discard from. */
  const stopEditing = useCallback(() => {
    setEditing(false);
    void autosave.flush();
  }, [autosave]);

  /**
   * A press outside the sheet ends editing; a press inside it never does.
   *
   * The boundary is the sheet, not the textarea, because everything the user
   * reaches for while editing — the check, the app's own menu over the text, the
   * error line — sits outside the field but inside the document they are working
   * on. Watching the field's own blur instead made those controls end the session
   * before their click landed, which is what silently broke "Вставить".
   */
  useEffect(() => {
    if (!editing) return;
    const outside = (event: MouseEvent) => {
      // A right click raises a menu; it is not a request to leave the document.
      if (event.button === 2) return;
      const target = event.target as HTMLElement | null;
      // The app's own menu is raised ON this document and is part of working in
      // it, even though it is rendered outside the sheet so it can escape the
      // scrolling boxes. Treating its items as "outside" is what silently broke
      // "Вставить": the field was gone before the paste could reach it.
      if (target?.closest?.('.context-menu')) return;
      if (!sheet.current?.contains(target as Node)) stopEditing();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [editing, stopEditing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void autosave.flush();
      }
      // Escape leaves and saves. It never discards: with versions gone, an undo
      // would be the one action in the app that destroys text for good. A menu
      // over the text takes the key first — closing it is the nearer meaning.
      if (event.key === 'Escape' && editing && !document.querySelector('.context-menu')) {
        event.preventDefault();
        stopEditing();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [autosave, editing, stopEditing]);

  /**
   * A right click over the document, with the selection resolved to source offsets.
   *
   * The event's default is prevented for the whole editor, rendered or raw: the
   * app's own menu replaces the system one rather than competing with it, and
   * Copy/Paste are offered inside it. The span is resolved here because only this
   * component knows both the rendered DOM and the exact Markdown behind it.
   */
  const raiseMenu = (event: React.MouseEvent) => {
    if (!onContextMenu) return;
    event.preventDefault();
    const text = (window.getSelection()?.toString() ?? '').trim();
    const block = text
      ? blockRangeOf(window.getSelection()?.anchorNode ?? null, event.currentTarget)
      : null;
    onContextMenu({
      text,
      span: text ? resolveSelectionSpan(draft, text, block) : null,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <div className="note-editor" ref={sheet} onContextMenu={raiseMenu}>
      {/* The one way in and the one way out, in the same corner of the sheet, so
          the control never moves under the hand that just used it. Muted while
          reading — a bright button over a document competes with the text — but
          never hidden: a control that only appears on hover is a control the
          user cannot find, which is the problem it exists to solve. */}
      <button
        type="button"
        className="note-editor__mode"
        data-editing={editing || undefined}
        aria-label={editing ? 'Готово' : 'Редактировать'}
        title={editing ? 'Готово' : 'Редактировать'}
        aria-pressed={editing}
        onClick={() => (editing ? stopEditing() : setEditing(true))}
      >
        <Icon name={editing ? 'check' : 'pencil'} size={16} />
      </button>
      {editing ? (
        <textarea
          ref={textarea}
          className="note-editor__text"
          aria-label="Текст конспекта"
          value={draft}
          spellCheck
          onChange={(event) => {
            setDraft(event.target.value);
            autosave.change(event.target.value);
          }}
        />
      ) : (
        <div
          className="note-editor__preview notes__content"
          aria-label="Конспект"
          // Focusable so a long note can be scrolled from the keyboard, but focus
          // alone no longer starts editing: tabbing through the panel used to turn
          // the page into raw Markdown without anyone asking for it.
          tabIndex={0}
        >
          {draft.trim() ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[markSourceOffsets, [highlightCitedText, note.citations]]}
              components={markdownComponents}
            >
              {draft}
            </ReactMarkdown>
          ) : (
            <p className="note-editor__placeholder">
              Пустой конспект — нажмите карандаш, чтобы писать.
            </p>
          )}
        </div>
      )}
      {error && <p role="alert" className="note-editor__error">{error}</p>}
    </div>
  );
}
