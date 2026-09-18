import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Note } from '../../api/types';

/**
 * The notes list, renaming and the generation indicator.
 *
 * These cover the three complaints that made Notes feel broken: existing notes were
 * invisible until the user guessed at the "+" menu, a note could not be named, and
 * generation gave no sign it had started.
 */

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'n1',
  revision: 1,
  content: '',
  title: '',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  model: 'test-model',
  citations: [],
  ...overrides,
});

const seed = (list: Note[]) => {
  useStore.setState({
    activeSessionId: 's1',
    sessions: [{ id: 's1', title: 'Лекция', created_at: '2026-01-01T00:00:00Z' } as never],
    detail: {
      segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' }],
      messages: [],
      notes: list[0] ?? null,
      notes_list: list,
    } as never,
    recorderState: 'stopped',
    notesGenerating: false,
    notesError: null,
    settings: { notes: { model: 'test-model' } } as never,
  });
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  window.audiohelper = {
    ...window.audiohelper,
    request: async <T,>(req: { method?: string; path: string; body?: unknown }) => {
      if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
        return { ok: true, status: 200, data: {
          segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' }],
          messages: [], notes: null, notes_list: [],
        } as T };
      }
      if (req.method === 'GET' && req.path.endsWith('/notes')) {
        return { ok: true, status: 200, data: { notes: [] } as T };
      }
      return { ok: true, status: 200, data: note({ revision: 2 }) as T };
    },
  } as never;
  seed([]);
});

describe('existing notes are shown, not guessed at', () => {
  it('lists the notes of the session instead of an empty state', () => {
    seed([
      note({ id: 'n1', title: 'Первая лекция', updated_at: '2026-01-02T00:00:00Z' }),
      note({ id: 'n2', content: '# Из текста\n\nтело', updated_at: '2026-01-01T00:00:00Z' }),
    ]);
    render(<NotesPanel onCite={vi.fn()} />);
    const list = screen.getByRole('list', { name: 'Конспекты сессии' });
    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Первая лекция');
    // An unnamed note falls back to the document's first line.
    expect(entries[1]).toHaveTextContent('Из текста');
    expect(screen.queryByText('Нет открытых конспектов')).not.toBeInTheDocument();
  });

  it('keeps both start buttons visible when the session has no notes at all', () => {
    render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Создать конспект с ИИ/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать пустой' })).toBeInTheDocument();
    // With nothing to show, the empty state still explains what this pane is for.
    expect(screen.getByText('Нет конспектов')).toBeInTheDocument();
  });

  it('drops the empty-state prose once there is a list, keeping only the buttons', () => {
    seed([note({ id: 'n1', title: 'Первая лекция' })]);
    render(<NotesPanel onCite={vi.fn()} />);
    // The list already says what this pane holds; a heading and a hint above it
    // are noise that push the notes down the pane.
    expect(screen.queryByText('Нет конспектов')).not.toBeInTheDocument();
    expect(screen.queryByText('Новый конспект', { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.queryByText(/те же действия есть в меню/)).not.toBeInTheDocument();
    // The two ways to start stay, exactly as before.
    expect(screen.getByRole('button', { name: /Создать конспект с ИИ/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать пустой' })).toBeInTheDocument();
  });

  it('opens a listed note on click and never opens one by itself', async () => {
    const user = userEvent.setup();
    seed([note({ id: 'n1', title: 'Первая лекция', content: 'тело заметки' })]);
    render(<NotesPanel onCite={vi.fn()} />);
    // Nothing is open until the user asks: a closed tab must stay closed.
    expect(screen.queryByLabelText('Конспект')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Открыть Первая лекция' }));
    expect(await screen.findByLabelText('Конспект')).toHaveTextContent('тело заметки');
  });
});

describe('renaming', () => {
  it('renames from the list without touching the document', async () => {
    const user = userEvent.setup();
    const sent: Array<{ path: string; body?: unknown }> = [];
    window.audiohelper = {
      ...window.audiohelper,
      request: async <T,>(req: { method?: string; path: string; body?: unknown }) => {
        if (req.method === 'PATCH') {
          sent.push({ path: req.path, body: req.body });
          return { ok: true, status: 200,
            data: note({ id: 'n1', revision: 2, title: 'Новое имя', content: 'тело' }) as T };
        }
        return { ok: true, status: 200, data: { notes: [] } as T };
      },
    } as never;
    seed([note({ id: 'n1', title: 'Старое имя', content: 'тело' })]);
    render(<NotesPanel onCite={vi.fn()} />);

    await user.dblClick(screen.getByText('Старое имя'));
    const field = await screen.findByLabelText('Название конспекта');
    await user.clear(field);
    await user.type(field, 'Новое имя{Enter}');

    await waitFor(() => expect(sent).toHaveLength(1));
    const [rename] = sent;
    expect(rename!.body).toMatchObject({ title: 'Новое имя' });
    // A rename is not an edit: it must not carry the document's text.
    expect(rename!.body).not.toHaveProperty('content');
    expect(await screen.findByText('Новое имя')).toBeInTheDocument();
  });

  it('restores the previous name when the field is cleared', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    window.audiohelper = {
      ...window.audiohelper,
      request: async <T,>(req: { method?: string; path: string; body?: unknown }) => {
        if (req.method === 'PATCH') sent.push(req.body);
        return { ok: true, status: 200, data: { notes: [] } as T };
      },
    } as never;
    seed([note({ id: 'n1', title: 'Старое имя' })]);
    render(<NotesPanel onCite={vi.fn()} />);

    await user.dblClick(screen.getByText('Старое имя'));
    const field = await screen.findByLabelText('Название конспекта');
    await user.clear(field);
    await user.type(field, '   {Enter}');

    // Nothing is sent and the old name is still on screen.
    expect(sent).toHaveLength(0);
    expect(await screen.findByText('Старое имя')).toBeInTheDocument();
  });
});

describe('generation indicator', () => {
  it('opens a tab with a spinner the moment generation starts', async () => {
    const user = userEvent.setup();
    let release: ((note: Note) => void) | null = null;
    window.audiohelper = {
      ...window.audiohelper,
      request: async <T,>(req: { method?: string; path: string }) => {
        if (req.method === 'POST' && req.path.endsWith('/notes')) {
          const result = await new Promise<Note>((resolve) => { release = resolve; });
          return { ok: true, status: 200, data: result as T };
        }
        if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
          return { ok: true, status: 200, data: {
            segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' }],
            messages: [], notes: null, notes_list: [],
          } as T };
        }
        return { ok: true, status: 200, data: { notes: [] } as T };
      },
    } as never;
    render(<NotesPanel onCite={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Создать конспект с ИИ/ }));
    const pending = await screen.findByRole('status', { name: 'Генерация конспекта' });
    expect(pending).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Генерация/ })).toBeInTheDocument();
    // Nothing may be typed into a document that does not exist yet.
    expect(screen.queryByLabelText('Текст конспекта')).not.toBeInTheDocument();

    await waitFor(() => expect(release).not.toBeNull());
    release!(note({ id: 'gen1', content: '# Готово\n\nтекст' }));
    expect(await screen.findByLabelText('Конспект')).toHaveTextContent('Готово');
    expect(screen.queryByRole('status', { name: 'Генерация конспекта' })).not.toBeInTheDocument();
  });

  it('keeps the tab with the reason and a retry when generation fails', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    window.audiohelper = {
      ...window.audiohelper,
      request: async <T,>(req: { method?: string; path: string }) => {
        if (req.method === 'POST' && req.path.endsWith('/notes')) {
          attempts += 1;
          if (attempts === 1) return { ok: false, status: 502, detail: 'Провайдер недоступен' };
          return { ok: true, status: 200, data: note({ id: 'gen1', content: '# Со второго раза' }) as T };
        }
        if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
          return { ok: true, status: 200, data: {
            segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' }],
            messages: [], notes: null, notes_list: [],
          } as T };
        }
        return { ok: true, status: 200, data: { notes: [] } as T };
      },
    } as never;
    render(<NotesPanel onCite={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Создать конспект с ИИ/ }));
    expect(await screen.findByText(/Провайдер недоступен/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Генерация/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByLabelText('Конспект')).toHaveTextContent('Со второго раза');
  });
});

describe('deleting a note', () => {
  it('removes it from the list through a soft delete', async () => {
    const user = userEvent.setup();
    const deleted: string[] = [];
    window.audiohelper = {
      ...window.audiohelper,
      request: async <T,>(req: { method?: string; path: string }) => {
        if (req.method === 'DELETE') {
          deleted.push(req.path);
          return { ok: true, status: 200, data: { deleted: true } as T };
        }
        return { ok: true, status: 200, data: { notes: [] } as T };
      },
    } as never;
    seed([note({ id: 'n1', title: 'Ненужная' }), note({ id: 'n2', title: 'Нужная' })]);
    render(<NotesPanel onCite={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Удалить Ненужная' }));
    await waitFor(() => expect(deleted).toEqual(['/sessions/s1/notes/n1']));
    await waitFor(() => expect(screen.queryByText('Ненужная')).not.toBeInTheDocument());
    expect(screen.getByText('Нужная')).toBeInTheDocument();
  });
});
