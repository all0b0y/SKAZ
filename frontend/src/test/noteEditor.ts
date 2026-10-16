import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Drive the Notes editor (CodeMirror) the way a user's keystrokes would, but
 * through its own API: jsdom has no layout, so real key events land at an
 * unpredictable caret. Every call is a genuine editor transaction and reaches
 * autosave exactly as typing does.
 */
export function editorView(element: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error('no CodeMirror view around this element');
  return view;
}

/** The note's current Markdown source, as the editor holds it. */
export function editorText(element: HTMLElement): string {
  return editorView(element).state.doc.toString();
}

/** Type `text` at the end of the document. */
export function typeAtEnd(element: HTMLElement, text: string): void {
  const view = editorView(element);
  const end = view.state.doc.length;
  view.dispatch({
    changes: { from: end, insert: text },
    selection: { anchor: end + text.length },
    userEvent: 'input.type',
  });
}

/** Select the first occurrence of `text` in the source. */
export function selectText(element: HTMLElement, text: string): void {
  const view = editorView(element);
  const from = view.state.doc.toString().indexOf(text);
  if (from < 0) throw new Error(`"${text}" is not in the note`);
  view.dispatch({ selection: EditorSelection.single(from, from + text.length) });
}
