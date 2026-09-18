import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Note } from '../../api/types';

/**
 * Editing is entered on purpose, through the pencil.
 *
 * A click in the text used to swap the rendered page for raw Markdown, so every
 * stray click turned a note into `##` and `**`, and the clicks that belong to
 * selecting a sentence or raising the app's menu were spent entering a mode
 * nobody asked for. The pencil is now the only way in; the check, a click
 * outside the sheet, and Escape are the ways out — and all of them save, because
 * with note versions gone a discard would destroy text for good.
 */

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'n1',
  revision: 1,
  content: '# Заголовок\n\nтело заметки',
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
  localStorage.setItem('audiohelper.noteTabs', JSON.stringify({
    tabs: [{ id: 't1', sessionId: 's1', noteId: open.id, title: open.title }],
    activeTabId: 't1',
  }));
  useStore.setState({
    activeSessionId: 's1',
    sessions: [{ id: 's1', title: 'Лекция', created_at: '2026-01-01T00:00:00Z' } as never],
    detail: { segments: [transcript], messages: [], notes: open, notes_list: [open] } as never,
    recorderState: 'stopped',
    notesGenerating: false,
    notesError: null,
    settings: { notes: { model: 'test-model' } } as never,
  });
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  sent = [];
  window.audiohelper = {
    ...window.audiohelper,
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

describe('entering editing', () => {
  it('leaves the rendered page alone when the text is clicked', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    const page = await screen.findByLabelText('Конспект');

    await user.click(page);

    expect(screen.getByLabelText('Конспект')).toBeInTheDocument();
    expect(screen.queryByLabelText('Текст конспекта')).not.toBeInTheDocument();
  });

  it('opens the raw text on the pencil, with the caret at the end', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await screen.findByLabelText('Конспект');

    await user.click(screen.getByRole('button', { name: 'Редактировать' }));

    const field = await screen.findByLabelText<HTMLTextAreaElement>('Текст конспекта');
    expect(field).toHaveFocus();
    // Continuing a note is what the pencil is for, so the caret waits at the end
    // rather than in front of the heading.
    expect(field.selectionStart).toBe(field.value.length);
    expect(field.selectionEnd).toBe(field.value.length);
    expect(screen.queryByRole('button', { name: 'Редактировать' })).not.toBeInTheDocument();
  });

  it('opens an empty note ready to type', async () => {
    seed(note({ content: '', title: 'Пустая' }));
    render(<NotesPanel onCite={vi.fn()} />);

    expect(await screen.findByLabelText('Текст конспекта')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Готово' })).toBeInTheDocument();
  });
});

describe('leaving editing', () => {
  const edit = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByLabelText('Конспект');
    await user.click(screen.getByRole('button', { name: 'Редактировать' }));
    const field = await screen.findByLabelText('Текст конспекта');
    await user.type(field, ' ещё');
    return field;
  };

  it('saves and renders again on the check', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await edit(user);

    await user.click(screen.getByRole('button', { name: 'Готово' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toMatchObject({ content: '# Заголовок\n\nтело заметки ещё' });
    expect(await screen.findByLabelText('Конспект')).toBeInTheDocument();
  });

  it('saves on a click outside the sheet', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await edit(user);

    await user.click(screen.getByRole('tab', { name: 'Первая' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(await screen.findByLabelText('Конспект')).toBeInTheDocument();
  });

  it('saves on Escape without discarding the text', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await edit(user);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toMatchObject({ content: '# Заголовок\n\nтело заметки ещё' });
  });

  it('keeps editing while the app\'s own menu over the text is used', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await edit(user);

    // The menu sits outside the textarea but inside the document being worked
    // on; ending the session on its click is what silently broke "Вставить".
    await user.pointer({ keys: '[MouseRight]', target: screen.getByLabelText('Текст конспекта') });
    const menu = await screen.findByRole('menu', { name: 'Действия с фрагментом' });
    expect(screen.getByLabelText('Текст конспекта')).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: 'Вставить' }));
    expect(screen.getByLabelText('Текст конспекта')).toBeInTheDocument();
  });
});
