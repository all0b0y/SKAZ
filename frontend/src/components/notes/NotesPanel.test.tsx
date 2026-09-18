import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Citation, Note } from '../../api/types';

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'n1',
  revision: 1,
  content: 'Some notes content.',
  created_at: '2026-01-01T00:00:00Z',
  model: 'test-model',
  citations: [],
  ...overrides,
});

const seed = (notes: Note | null, list?: Note[]) => {
  useStore.setState({
    activeSessionId: 's1',
    sessions: [{ id: 's1', title: 'Лекция', created_at: '2026-01-01T00:00:00Z' } as never],
    detail: {
      segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' }],
      messages: [],
      notes,
      notes_list: list ?? (notes ? [notes] : []),
    } as never,
    recorderState: 'stopped',
    notesGenerating: false,
    notesError: null,
  });
};

/** Open the note in a tab the way a user does: "+" → "Открыть существующий". */
const openFirstNote = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Новый конспект' }));
  await user.click(screen.getByRole('menuitem', { name: 'Открыть существующий' }));
  // Scoped to the picker: the session's own note list shows the same names
  // behind the dialog, and an unscoped query cannot tell the two apart.
  const picker = await screen.findByRole('dialog', { name: 'Открыть конспект' });
  const entry = await within(picker)
    .findByRole('button', { name: /Some notes content|Без названия|Заголовок/ });
  await user.click(entry);
};

/** The note opens rendered; editing is entered through the pencil in its corner. */
const enterEditing = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByLabelText('Конспект');
  await user.click(screen.getByRole('button', { name: 'Редактировать' }));
  return screen.findByLabelText('Текст конспекта');
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  window.audiohelper = {
    ...window.audiohelper,
    request: async <T,>(req: { method?: string; path: string }) => {
      if (req.path.endsWith('/notes')) {
        return { ok: true, status: 200, data: { notes: [note()] } as T };
      }
      // The panel re-reads the session after Stop; a bare note here would hand
      // the component a detail with no segments and crash the render.
      if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
        return { ok: true, status: 200, data: {
          segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' }],
          messages: [], notes: null, notes_list: [],
        } as T };
      }
      return { ok: true, status: 200, data: note({ revision: 2 }) as T };
    },
  } as never;
  seed(null);
});

describe('NotesPanel start screen', () => {
  it('offers both ways to start and never hides either', () => {
    render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Создать конспект с ИИ/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать пустой' })).toBeInTheDocument();
  });

  it('disables AI generation with the reason on the button when there is no transcript', () => {
    useStore.setState({
      detail: { segments: [], messages: [], notes: null, notes_list: [] } as never,
    });
    render(<NotesPanel onCite={vi.fn()} />);
    const generate = screen.getByRole('button', { name: /Создать конспект с ИИ/ });
    expect(generate).toBeDisabled();
    expect(generate).toHaveTextContent('Нет транскрипции');
    // The empty note never depends on the recording.
    expect(screen.getByRole('button', { name: 'Создать пустой' })).toBeEnabled();
  });

  it('says to stop the recording rather than silently refusing while capturing', () => {
    useStore.setState({ recorderState: 'recording' });
    render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Создать конспект с ИИ/ }))
      .toHaveTextContent('Остановите запись');
  });
});

describe('NotesPanel tabs', () => {
  it('shows a note as formatted Markdown and swaps to the raw source on the pencil', async () => {
    const user = userEvent.setup();
    seed(note({ content: '# Заголовок\n\nSome notes content.' }));
    render(<NotesPanel onCite={vi.fn()} />);
    await openFirstNote(user);
    // At rest it reads as a document: a real heading, no visible "#".
    const preview = await screen.findByLabelText('Конспект');
    expect(preview.querySelector('h1')).toHaveTextContent('Заголовок');
    expect(preview.textContent).not.toContain('#');
    expect(screen.queryByLabelText('Текст конспекта')).not.toBeInTheDocument();

    const editor = await enterEditing(user);
    expect(editor).toHaveValue('# Заголовок\n\nSome notes content.');
    // No mode to enter and no replace action: both were removed on purpose.
    expect(screen.queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Заменить текущую' })).not.toBeInTheDocument();
  });

  it('renders the Markdown again once the check is pressed', async () => {
    const user = userEvent.setup();
    seed(note({ content: '# Заголовок' }));
    render(<NotesPanel onCite={vi.fn()} />);
    await openFirstNote(user);
    await enterEditing(user);
    // Blur is deliberately NOT the way out: the check, the app's menu over the
    // text and the error line all live outside the field, and leaving on their
    // focus change ended the session before their click could land.
    fireEvent.blur(screen.getByLabelText('Текст конспекта'));
    expect(screen.getByLabelText('Текст конспекта')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Готово' }));
    const preview = await screen.findByLabelText('Конспект');
    expect(preview.querySelector('h1')).toHaveTextContent('Заголовок');
    expect(screen.queryByLabelText('Текст конспекта')).not.toBeInTheDocument();
  });

  it('never enters editing from a click in the text, selection or not', async () => {
    const user = userEvent.setup();
    seed(note({ content: 'Some notes content.' }));
    render(<NotesPanel onCite={vi.fn()} />);
    await openFirstNote(user);
    await screen.findByLabelText('Конспект');

    // A plain click used to turn the page into raw Markdown; now only the pencil
    // does, so selecting a sentence to ask about it survives the click that made it.
    await user.click(screen.getByLabelText('Конспект'));
    expect(screen.queryByLabelText('Текст конспекта')).not.toBeInTheDocument();

    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'Some notes content.', rangeCount: 1,
    } as unknown as Selection);
    await user.click(screen.getByLabelText('Конспект'));
    expect(screen.queryByLabelText('Текст конспекта')).not.toBeInTheDocument();
  });

  it('closes a tab and returns to the start screen when it was the last one', async () => {
    const user = userEvent.setup();
    seed(note());
    render(<NotesPanel onCite={vi.fn()} />);
    await openFirstNote(user);
    await user.click(await screen.findByRole('button', { name: /^Закрыть / }));
    expect(screen.queryByLabelText('Конспект')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать пустой' })).toBeInTheDocument();
  });

  it('keeps the open tabs across a remount, which is what a restart looks like', async () => {
    const user = userEvent.setup();
    seed(note());
    const first = render(<NotesPanel onCite={vi.fn()} />);
    await openFirstNote(user);
    await screen.findByLabelText('Конспект');
    first.unmount();

    render(<NotesPanel onCite={vi.fn()} />);
    expect(await screen.findByLabelText('Конспект')).toHaveTextContent('Some notes content.');
  });
});

describe('NotesPanel tools menu', () => {
  it('offers only the tools that actually work', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Новый конспект' }));
    expect(screen.getByRole('menuitem', { name: /Создать конспект с ИИ/ })).toBeInTheDocument();
    // Translation and restyling are planned but unimplemented; a greyed-out entry
    // would make a working app look broken.
    expect(screen.queryByRole('menuitem', { name: /Перевод/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Стиль/ })).not.toBeInTheDocument();
  });

  it('remembers the chosen detail level', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Новый конспект' }));
    await user.click(screen.getByRole('radio', { name: 'Подробно' }));
    expect(localStorage.getItem('audiohelper.noteDetail')).toBe('detailed');
    expect(screen.getByRole('radio', { name: 'Подробно' })).toHaveAttribute('aria-checked', 'true');
  });

  it('sends the chosen detail level with the generation request', async () => {
    const requests: Array<{ method?: string; path: string; body?: unknown }> = [];
    window.audiohelper = {
      ...window.audiohelper,
      request: async <T,>(req: { method?: string; path: string; body?: unknown }) => {
        requests.push(req);
        if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
          return { ok: true, status: 200, data: {
            segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' }],
            messages: [], notes: null, notes_list: [],
          } as T };
        }
        return { ok: true, status: 200, data: note({ id: 'gen' }) as T };
      },
    } as never;
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Новый конспект' }));
    await user.click(screen.getByRole('radio', { name: 'Тезисно' }));
    await user.click(screen.getByRole('menuitem', { name: /Создать конспект с ИИ/ }));
    // The panel also re-reads the transcript; only the generation POST is meant.
    const generation = () => requests.find((req) => req.method === 'POST');
    await waitFor(() => expect(generation()?.body).toMatchObject({ detail: 'brief' }));
    // Generation must never ask the backend to overwrite an existing note.
    expect(generation()?.body).not.toHaveProperty('replace_note_id');
  });
});

describe('NotesPanel sources', () => {
  it('never shows a sources list or highlights generated text', async () => {
    const user = userEvent.setup();
    const citation: Citation = { segment_id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' };
    seed(note({ citations: [citation] }));
    render(<NotesPanel onCite={vi.fn()} />);
    await openFirstNote(user);
    await screen.findByLabelText('Конспект');
    expect(document.querySelector('details.notes__sources')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sources \(/)).not.toBeInTheDocument();
    expect(document.querySelector('[data-cited]')).not.toBeInTheDocument();
  });

  // The actions over a selection — their availability, the jump, Ask, and the
  // regeneration flow — live in NotesPanel.rewrite.test.tsx, where the menu that
  // now carries them is driven the way a user raises it: a right click.
});
