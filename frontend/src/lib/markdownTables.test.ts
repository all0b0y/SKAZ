import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { livePreview } from './livePreview';
import { setTableFocus } from './markdownTables';

// CODEX-NOTES-FIX-SPEC §4: a table renders as a table away from the caret and
// reveals its whole source when the caret enters it. The stored text never changes.

const DOC = [
  'Сравнение:',
  '',
  '| Вопрос | Друкер | Фридман |',
  '|---|:---:|---:|',
  '| Фокус | **Клиент** | Акционеры |',
  '| Роль прибыли | Индикатор | Обязанность |',
  '',
  'После таблицы.',
].join('\n');

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });

function open(doc = DOC): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  view = new EditorView({ state: EditorState.create({ doc, extensions: livePreview() }), parent });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  view.dispatch({}); // rebuild decorations against the complete tree
  return view;
}

const table = (v: EditorView) => v.dom.querySelector('table.cm-md-table');
const sourceVisible = (v: EditorView) => v.contentDOM.textContent?.includes('|---|') ?? false;

describe('markdown tables in the note editor', () => {
  it('draws a table with header, cells, alignment and plain cell text', () => {
    const v = open();
    const rendered = table(v);
    expect(rendered).not.toBeNull();
    expect([...rendered!.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Вопрос', 'Друкер', 'Фридман']);
    expect([...rendered!.querySelectorAll('tbody tr')].map((r) => r.textContent))
      .toEqual(['ФокусКлиентАкционеры', 'Роль прибылиИндикаторОбязанность']);
    const cells = rendered!.querySelectorAll('th');
    expect((cells[1] as HTMLElement).style.textAlign).toBe('center');
    expect((cells[2] as HTMLElement).style.textAlign).toBe('right');
    expect(sourceVisible(v)).toBe(false);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it('reveals the whole table source when the focused caret is inside it', () => {
    const v = open();
    const inside = DOC.indexOf('Индикатор');
    v.dispatch({ selection: { anchor: inside }, effects: setTableFocus.of(true) });
    expect(table(v)).toBeNull();
    expect(sourceVisible(v)).toBe(true);
    expect(v.contentDOM.textContent).toContain('| Вопрос | Друкер | Фридман |');
    // Leaving the table, or losing focus, draws it again.
    v.dispatch({ selection: { anchor: DOC.length } });
    expect(table(v)).not.toBeNull();
    v.dispatch({ selection: { anchor: inside }, effects: setTableFocus.of(false) });
    expect(table(v)).not.toBeNull();
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it('puts the caret into the clicked cell source', () => {
    const v = open();
    const cell = [...table(v)!.querySelectorAll('td')].find((c) => c.textContent === 'Акционеры') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(v.state.selection.main.head).toBe(DOC.indexOf('Акционеры'));
    expect(table(v)).toBeNull();
  });

  it('leaves non-table text and a lone pipe line alone', () => {
    const v = open('Просто текст | с чертой\n\nЕщё абзац.');
    expect(table(v)).toBeNull();
  });
});
