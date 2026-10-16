/**
 * Markdown tables in the Notes editor (CODEX-NOTES-FIX-SPEC §4).
 *
 * Away from the caret a table is drawn as a real table; once the caret enters it,
 * the whole table's Markdown source comes back for editing — the table as one
 * unit, not the single line, because a row out of context is unreadable. The
 * document itself is never rewritten, so anchors and the projected `.md` keep
 * addressing the same characters.
 *
 * A table spans several lines, and CodeMirror only accepts such replacing
 * decorations from a state field, not a view plugin — hence a field, plus a
 * small focus flag in state so an unfocused note reads as a finished document,
 * the same rule the rest of the live preview follows.
 */
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

/** A syntax node, typed from what `syntaxTree` already exports (no extra dependency). */
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

type Align = 'left' | 'center' | 'right' | null;

interface Cell { text: string; from: number }
interface TableModel { header: Cell[]; rows: Cell[][]; align: Align[] }

/** Whether the editor has focus; kept in state so the field can depend on it. */
export const setTableFocus = StateEffect.define<boolean>();

const focusField = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setTableFocus) ? e.value : v), value),
});

/** Inline marks a cell may carry; the rendered table shows the words, not the syntax. */
const INLINE_MARKS = /(\*\*|__|\*|_|`|~~)(.+?)\1/g;

function cellsOf(row: SyntaxNode, state: EditorState): Cell[] {
  const cells: Cell[] = [];
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'TableCell') continue;
    const raw = state.doc.sliceString(child.from, child.to).trim();
    cells.push({ text: raw.replace(INLINE_MARKS, '$2'), from: child.from });
  }
  return cells;
}

function alignments(line: string): Align[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((part) => {
    const spec = part.trim();
    const left = spec.startsWith(':');
    const right = spec.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

function modelOf(table: SyntaxNode, state: EditorState): TableModel | null {
  let header: Cell[] | null = null;
  let align: Align[] = [];
  const rows: Cell[][] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader') header = cellsOf(child, state);
    else if (child.name === 'TableRow') rows.push(cellsOf(child, state));
    else if (child.name === 'TableDelimiter' && header && !align.length) {
      align = alignments(state.doc.sliceString(child.from, child.to));
    }
  }
  return header ? { header, rows, align } : null;
}

class TableWidget extends WidgetType {
  constructor(readonly model: TableModel, readonly source: string) { super(); }

  eq(other: TableWidget): boolean { return other.source === this.source; }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'cm-md-table';
    const cell = (tag: 'th' | 'td', value: Cell | undefined, column: number, from: number) => {
      const element = document.createElement(tag);
      element.textContent = value?.text ?? '';
      // A click on a cell puts the caret into that cell's source, not at the table start.
      element.dataset.mdFrom = String(value?.from ?? from);
      const align = this.model.align[column];
      if (align) element.style.textAlign = align;
      return element;
    };
    const columns = Math.max(this.model.header.length, ...this.model.rows.map((r) => r.length));
    const firstFrom = this.model.header[0]?.from ?? 0;
    const head = table.createTHead().insertRow();
    for (let i = 0; i < columns; i += 1) head.append(cell('th', this.model.header[i], i, firstFrom));
    const body = table.createTBody();
    for (const row of this.model.rows) {
      const line = body.insertRow();
      for (let i = 0; i < columns; i += 1) line.append(cell('td', row[i], i, row[0]?.from ?? firstFrom));
    }
    wrap.append(table);
    return wrap;
  }

  /** Let the editor see clicks, so a click can place the caret and reveal the source. */
  ignoreEvent(): boolean { return false; }
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function buildTables(state: EditorState): DecorationSet {
  const focused = state.field(focusField);
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      // Whole lines: a replaced block must start and end on line boundaries.
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      if (focused && selectionTouches(state, from, to)) return false;
      const model = modelOf(node.node, state);
      if (model) {
        ranges.push(Decoration.replace({
          widget: new TableWidget(model, state.doc.sliceString(from, to)),
          block: true,
        }).range(from, to));
      }
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update: (value, tr) => (
    tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setTableFocus))
      || syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ? buildTables(tr.state) : value
  ),
  provide: (field) => EditorView.decorations.from(field),
});

const tableClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-md-from]') : null;
    if (!target || !view.dom.contains(target)) return false;
    const at = Number(target.dataset.mdFrom);
    if (!Number.isFinite(at)) return false;
    event.preventDefault();
    view.focus();
    view.dispatch({ selection: { anchor: at }, effects: setTableFocus.of(true), scrollIntoView: true });
    return true;
  },
});

const tableTheme = EditorView.theme({
  // Sized by the page, scrolling sideways inside itself (PANES-SPEC §3); the
  // editor's line wrapping breaks anywhere, which squeezed cells to one letter.
  '.cm-md-table-wrap': { overflowX: 'auto', padding: '4px 0', maxWidth: '100%', contain: 'inline-size' },
  '.cm-md-table': { borderCollapse: 'collapse', fontSize: '0.95em', cursor: 'text', overflowWrap: 'normal', wordBreak: 'normal' },
  '.cm-md-table th, .cm-md-table td': {
    border: '1px solid var(--edge-strong)', padding: '4px 10px', verticalAlign: 'top', minWidth: '4ch',
  },
  '.cm-md-table th': { fontWeight: '600' },
});

export function markdownTables(): Extension {
  return [
    focusField,
    EditorView.focusChangeEffect.of((_state, focusing) => setTableFocus.of(focusing)),
    tableField,
    tableClicks,
    tableTheme,
  ];
}
