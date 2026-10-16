/**
 * Obsidian-style live preview for the Notes editor (docs/NOTES-POLISH-SPEC.md §2, §7).
 *
 * The document is plain Markdown and stays plain Markdown: nothing here rewrites
 * the text, it only changes how it is drawn. Headings, bold, italics and lists
 * are styled; their marks (`#`, `**`, `-`) are hidden everywhere except on the
 * line the caret is on, and only while the editor has focus — so an unfocused
 * note reads as a finished document and the line being edited shows its source.
 *
 * Keeping the source untouched is the point: note anchors, passage regeneration
 * and the projected `.md` file all address the stored text by character offset.
 */
import { indentLess, indentMore } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { EditorSelection, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type KeyBinding,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { markdownTables } from './markdownTables';

/** Marks that exist only to format; hidden away from the caret line. */
const HIDDEN_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'QuoteMark', 'StrikethroughMark']);

class BulletWidget extends WidgetType {
  eq(): boolean { return true; }
  toDOM(): HTMLElement {
    const bullet = document.createElement('span');
    bullet.className = 'cm-md-bullet';
    bullet.textContent = '•';
    return bullet;
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() });
const hide = Decoration.replace({});

/** Lines the caret (or a selection) touches: their marks stay visible for editing. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) lines.add(line);
  }
  return lines;
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(view);
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const heading = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(node.name);
        if (heading) {
          ranges.push(Decoration.line({ class: `cm-md-h cm-md-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
          return;
        }
        if (node.name === 'Blockquote') {
          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            ranges.push(Decoration.line({ class: 'cm-md-quote' }).range(line.from));
            pos = line.to + 1;
          }
          return;
        }
        const line = state.doc.lineAt(node.from).number;
        if (active.has(line)) return;
        if (node.name === 'ListMark') {
          const mark = state.doc.sliceString(node.from, node.to);
          // Ordered markers ("1.") carry information and stay as they are.
          if (mark === '-' || mark === '*' || mark === '+') ranges.push(bullet.range(node.from, node.to));
          return;
        }
        if (HIDDEN_MARKS.has(node.name)) {
          // A heading mark takes the space after it too, or the title would
          // start one blank character in from the text below it.
          let end = node.to;
          if ((node.name === 'HeaderMark' || node.name === 'QuoteMark') && state.doc.sliceString(end, end + 1) === ' ') end += 1;
          if (end > node.from) ranges.push(hide.range(node.from, end));
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildDecorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
      || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

const markdownStyle = HighlightStyle.define([
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.88em' },
  { tag: tags.link, textDecoration: 'underline' },
  { tag: [tags.processingInstruction, tags.meta], color: 'var(--ink-faint)' },
]);

/**
 * Wrap the selection in `mark`, or unwrap it when it already is wrapped.
 * An empty selection gets an empty pair with the caret between, as editors do.
 */
export function toggleWrap(mark: string) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const size = mark.length;
    view.dispatch(state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - size, range.from);
      const after = state.sliceDoc(range.to, range.to + size);
      if (before === mark && after === mark) {
        return {
          changes: [{ from: range.from - size, to: range.from }, { from: range.to, to: range.to + size }],
          range: EditorSelection.range(range.from - size, range.to - size),
        };
      }
      return {
        changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
        range: EditorSelection.range(range.from + size, range.to + size),
      };
    }), { scrollIntoView: true, userEvent: 'input' });
    return true;
  };
}

/** ⌘B / ⌘I and Tab nesting. Enter-continues-list comes from the Markdown keymap. */
export const formattingKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleWrap('**') },
  { key: 'Mod-i', run: toggleWrap('*') },
  { key: 'Tab', run: indentMore },
  { key: 'Shift-Tab', run: indentLess },
];

/** The document's look: the same reading type as the Transcript, no box. */
const editorTheme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', fontSize: 'var(--text-md)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-read)', lineHeight: '1.7', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-md-h': { fontWeight: '600', lineHeight: '1.3' },
  // Markdown already separates blocks with a blank line; headings add only a
  // little on top of it, or every section break reads as a gap in the page.
  '.cm-md-h1': { fontSize: '1.7em', paddingBottom: '0.1em' },
  '.cm-md-h2': { fontSize: '1.3em', paddingTop: '0.2em' },
  '.cm-md-h3': { fontSize: '1.12em', paddingTop: '0.15em' },
  '.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontSize: '1em' },
  '.cm-md-quote': { borderLeft: '3px solid var(--edge-strong)', paddingLeft: '12px', color: 'var(--ink-soft)' },
  '.cm-md-bullet': { color: 'var(--ink-soft)' },
  '.cm-placeholder': { color: 'var(--ink-faint)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--ink) 16%, transparent)',
  },
});

/** Everything the Notes editor needs besides its React wiring. */
export function livePreview(): Extension {
  return [
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(markdownStyle),
    livePreviewPlugin,
    markdownTables(),
    editorTheme,
    EditorView.lineWrapping,
  ];
}
