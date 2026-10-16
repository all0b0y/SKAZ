import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Note } from '../../api/types';
import { editorText, editorView, selectText, typeAtEnd } from '../../test/noteEditor';

/**
 * The note is an Obsidian-style document (docs/NOTES-POLISH-SPEC.md §2, §7).
 *
 * There is no reading mode, no pencil and no check: the text is always editable,
 * Markdown marks show only on the line being edited, and formatting comes from
 * hotkeys and Markdown typed as-is. The stored text stays plain Markdown.
 */

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'n1',
  revision: 1,
  content: '# Заголовок\n\nтело **важное** заметки\n\n- пункт',
  title: 'Первая',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  model: 'test-model',
  citations: [],
  ...overrides,
});

const transcript = { id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' };

let sent: Array<{ method?: string; path: string; body?: unknown }>;

const seed = (open: Note) => {
  useStore.setState({ noteTabs: { s1: {
    tabs: [{ id: 't1', sessionId: 's1', noteId: open.id ?? null, title: open.title ?? '' }],
    activeTabId: 't1',
  } } });
  useStore.setState({
    activeSessionId: 's1',
    detailLoading: false,
    sessions: [{ id: 's1', title: 'Лекция', created_at: '2026-01-01T00:00:00Z' } as never],
    detail: { segments: [transcript], messages: [], notes: open, notes_list: [open] } as never,
    recorderState: 'stopped',
    noteGenerations: {},
    notesError: null,
    settings: { notes: { model: 'test-model' } } as never,
  });
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  sent = [];
  window.skaz = {
    ...window.skaz,
    request: async <T,>(req: { method?: string; path: string; body?: unknown }) => {
      sent.push(req);
      if (req.method === 'PATCH') {
        const body = req.body as { title?: string; content?: string };
        return { ok: true, status: 200, data: note({ revision: 2, ...body }) as T };
      }
      if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
        return { ok: true, status: 200,
          data: { segments: [transcript], messages: [], notes: null, notes_list: [] } as T };
      }
      return { ok: true, status: 200, data: { notes: [] } as T };
    },
  } as never;
  seed(note());
});

const writes = () => sent.filter((req) => req.method === 'PATCH');

/** CodeMirror's "Mod": ⌘ on macOS (the app), Ctrl elsewhere (jsdom's platform). */
const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

describe('one editable document', () => {
  it('has no reading mode: no pencil, no check, no second text field', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    expect(doc).toHaveAttribute('contenteditable', 'true');
    expect(screen.queryByRole('button', { name: 'Редактировать' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Текст конспекта')).not.toBeInTheDocument();
  });

  it('keeps the stored Markdown intact while drawing it formatted', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    // The source is untouched…
    expect(editorText(doc)).toBe(note().content);
    // …but unfocused, no mark shows: a heading line, bold text, a bullet.
    expect(doc.textContent).not.toMatch(/[#*]/);
    expect(doc.querySelector('.cm-md-h1')).toHaveTextContent('Заголовок');
    expect(doc.querySelector('.cm-md-bullet')).toHaveTextContent('•');
  });

  it('shows the marks of the line being edited, and only of that line', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    const view = editorView(doc);
    view.focus();
    selectText(doc, 'важное');
    await waitFor(() => expect(doc.textContent).toContain('**важное**'));
    expect(doc.querySelector('.cm-md-h1')?.textContent).not.toContain('#');
  });

  it('opens an empty note ready to type', async () => {
    seed(note({ content: '', title: 'Пустая' }));
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    await waitFor(() => expect(editorView(doc).hasFocus).toBe(true));
  });
});

describe('saving', () => {
  it('saves what was typed without any button being pressed', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    typeAtEnd(doc, ' ещё');
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 4_000 });
    expect(writes()[0]!.body).toMatchObject({ content: `${note().content} ещё` });
  }, 10_000);

  it('saves at once on Cmd+S', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    typeAtEnd(doc, '!');
    fireEvent.keyDown(editorView(doc).contentDOM, { key: 's', ...mod });
    await waitFor(() => expect(writes()).toHaveLength(1));
  });

  it('saves on closing the tab', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    typeAtEnd(doc, '!');
    await user.click(screen.getByRole('button', { name: 'Close Первая' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
  });
});

describe('formatting from the keyboard', () => {
  const press = (doc: HTMLElement, key: string) => {
    fireEvent.keyDown(editorView(doc).contentDOM, { key, ...mod });
  };

  it('toggles bold with Cmd+B around the selection', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    selectText(doc, 'пункт');
    press(doc, 'b');
    expect(editorText(doc)).toContain('- **пункт**');
    press(doc, 'b');
    expect(editorText(doc)).toContain('- пункт');
    expect(editorText(doc)).not.toContain('**пункт**');
  });

  it('wraps the selection in italics with Cmd+I', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    selectText(doc, 'тело');
    press(doc, 'i');
    expect(editorText(doc)).toContain('*тело* **важное**');
  });

  it('continues a list on Enter', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    const view = editorView(doc);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' });
    expect(editorText(doc).endsWith('- пункт\n- ')).toBe(true);
  });

  it('nests a list item with Tab', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    selectText(doc, 'пункт');
    fireEvent.keyDown(editorView(doc).contentDOM, { key: 'Tab' });
    expect(editorText(doc)).toMatch(/\n\s+- пункт$/);
  });
});

describe('the menu over the text', () => {
  it('pastes where the selection is through the app\'s own menu', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    const doc = await screen.findByLabelText('Notes');
    vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('вставка');
    selectText(doc, 'пункт');
    await user.pointer({ keys: '[MouseRight]', target: doc });
    const menu = await screen.findByRole('menu', { name: 'Passage actions' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Paste' }));
    await waitFor(() => expect(editorText(doc)).toContain('- вставка'));
  });
});
