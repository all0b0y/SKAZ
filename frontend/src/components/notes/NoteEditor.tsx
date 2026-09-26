import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { ApiClient } from '../../api/client';
import type { Note } from '../../api/types';
import { Autosave, type SaveStatus } from '../../lib/autosave';
import { formattingKeymap, livePreview } from '../../lib/livePreview';

/** A character range in the note's stored Markdown. */
export interface SourceSpan {
  start: number;
  end: number;
}

/** What the user pointed at: the text, and where it lives in the stored Markdown. */
export interface EditorSelection {
  text: string;
  /** Exact offsets of `text` in the stored Markdown; null when nothing is selected. */
  span: SourceSpan | null;
  x: number;
  y: number;
  /** Put text where the selection is — the menu's "Вставить". */
  insert: (text: string) => void;
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
  /** Receives a way to save pending edits now and read the text on screen. */
  onHandle?: (handle: EditorHandle | null) => void;
}

/** What the panel may ask of an open editor without owning its state. */
export interface EditorHandle {
  noteId: string | undefined;
  /** Write pending edits; resolves with the text that is now on screen. */
  flush: () => Promise<string>;
}

/** Marks a transaction that loads stored text rather than recording an edit. */
const external = Annotation.define<boolean>();

/**
 * The note as an Obsidian-style document (docs/NOTES-POLISH-SPEC.md §2).
 *
 * There is no reading mode and no pencil: the text is always editable, and the
 * Markdown marks show only on the line being edited (see `lib/livePreview`).
 * The stored text is plain Markdown and the editor never rewrites it, so a
 * selection is named by exact character offsets into it — no guessing from
 * rendered text.
 *
 * Note content is generated from an untrusted transcript (AGENTS.md). The editor
 * draws it as text; nothing in it is executed or turned into HTML.
 *
 * Saving is never the user's job. With note versions gone, losing text is
 * unrecoverable, so the editor writes on idle and on unmount — a tab close, a
 * session change or a quit. The dot in the tab strip only reports that state.
 */
export function NoteEditor({ sessionId, note, onSaved, onStatusChange, onContextMenu, onHandle }: Props) {
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The revision moves with every accepted write, so the next save carries the
  // right expectation and a stale one is rejected instead of clobbering.
  const current = useRef(note);
  const report = useRef(onStatusChange);
  report.current = onStatusChange;
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const menu = useRef(onContextMenu);
  menu.current = onContextMenu;

  const autosave = useMemo(() => new Autosave({
    save: async (content) => {
      const stored = await new ApiClient(window.audiohelper).editNote(sessionId, current.current, content);
      current.current = stored;
      saved.current(stored);
    },
    onStatus: (next, message) => {
      const detail = next === 'error' ? (message ?? 'Could not save') : null;
      setError(detail);
      report.current?.(next, detail);
    },
  // A different note is a different document: it gets its own autosave rather
  // than one still holding the previous note's pending text.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sessionId, note.id]);

  // One editor per document. Re-creating it on content updates would throw away
  // the caret, the undo history and whatever the user is typing right now.
  useEffect(() => {
    if (!host.current) return undefined;
    current.current = note;
    setError(null);
    report.current?.('saved', null);
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: note.content,
        extensions: [
          history(),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { void autosave.flush(); return true; } },
            ...formattingKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          livePreview(),
          placeholder('Start writing…'),
          EditorView.contentAttributes.of({ 'aria-label': 'Notes', spellcheck: 'true' }),
          EditorView.updateListener.of((update) => {
            // Stored text loaded from outside (an applied passage rewrite) is
            // already saved; only the user's own edits are written from here.
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(external))) {
              autosave.change(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    // An empty note has nothing to read; it opens ready to type.
    if (!note.content.trim()) editor.focus();
    return () => {
      view.current = null;
      editor.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, autosave]);

  // A newer revision that did not come from this editor's own save — an applied
  // passage rewrite — replaces the text on screen. Our own saves arrive here
  // carrying the revision already held and are ignored, so typing is never
  // overwritten by the echo of its own save.
  useEffect(() => {
    const editor = view.current;
    if (!editor || note.revision === current.current.revision) return;
    current.current = note;
    if (editor.state.doc.toString() !== note.content) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: note.content },
        annotations: external.of(true),
      });
    }
  }, [note]);

  useEffect(() => () => {
    void autosave.flush().finally(() => autosave.dispose());
  }, [autosave]);

  const handleOut = useRef(onHandle);
  handleOut.current = onHandle;
  useEffect(() => {
    handleOut.current?.({
      noteId: note.id,
      flush: async () => {
        await autosave.flush();
        return view.current?.state.doc.toString() ?? current.current.content;
      },
    });
    return () => handleOut.current?.(null);
  }, [autosave, note.id]);

  /**
   * A right click over the document raises the app's own menu with the exact
   * selection. The span is trimmed of surrounding whitespace so it names the
   * same characters the menu acts on, and a regeneration rewrites no more.
   */
  const raiseMenu = (event: React.MouseEvent) => {
    const editor = view.current;
    if (!menu.current || !editor) return;
    event.preventDefault();
    const { from, to } = editor.state.selection.main;
    const raw = editor.state.sliceDoc(from, to);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    menu.current({
      text,
      span: text ? { start: from + lead, end: from + lead + text.length } : null,
      x: event.clientX,
      y: event.clientY,
      insert: (inserted) => {
        const target = view.current;
        if (!target) return;
        target.dispatch(target.state.replaceSelection(inserted), { userEvent: 'input.paste' });
        target.focus();
      },
    });
  };

  return (
    <div className="note-editor" onContextMenu={raiseMenu}>
      <div ref={host} className="note-editor__surface" />
      {error && <p role="alert" className="note-editor__error">{error}</p>}
    </div>
  );
}
