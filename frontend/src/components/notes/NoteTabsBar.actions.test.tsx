import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Note } from '../../api/types';

/**
 * Renaming and deleting from the TAB, not only from the list.
 *
 * Decisions 9 and 14 of NOTES-LIST-TITLE-SPEC name both entry points. A note open
 * in a tab is exactly the note the user is thinking about, and sending them back
 * to a list they can only reach by closing the tab is the long way round.
 *
 * Both now live behind a right click. The strip carries one visible control — the
 * close "×" — because a row of icons on every tab is what made it look busy, and
 * a double click is too easy to fire while switching tabs quickly.
 */

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'n1',
  revision: 1,
  content: 'тело заметки',
  title: 'Старое имя',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  model: 'test-model',
  citations: [],
  ...overrides,
});

const transcript = { id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' };

const seed = (list: Note[]) => {
  useStore.setState({
    activeSessionId: 's1',
    sessions: [{ id: 's1', title: 'Лекция', created_at: '2026-01-01T00:00:00Z' } as never],
    detail: {
      segments: [transcript], messages: [], notes: list[0] ?? null, notes_list: list,
    } as never,
    recorderState: 'stopped',
    notesGenerating: false,
    notesError: null,
    settings: { notes: { model: 'test-model' } } as never,
  });
};

/** Open the first listed note into a tab, the way the list does it. */
const openFromList = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('button', { name: `Открыть ${name}` }));
  await screen.findByLabelText('Конспект');
};

/** Right click the tab, which is the only way to its actions now. */
const openTabMenu = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('tab', { name }) });
  return screen.findByRole('menu', { name: `Конспект «${name}»` });
};

let sent: Array<{ method?: string; path: string; body?: unknown }>;

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
      if (req.method === 'DELETE') return { ok: true, status: 200, data: { deleted: true } as T };
      if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
        return { ok: true, status: 200,
          data: { segments: [transcript], messages: [], notes: null, notes_list: [] } as T };
      }
      if (req.path.endsWith('/notes/empty')) {
        return { ok: true, status: 200,
          data: note({ id: 'n-empty', title: '', content: '' }) as T };
      }
      return { ok: true, status: 200, data: { notes: [] } as T };
    },
  } as never;
  seed([note()]);
});

describe('the tab strip carries no icon row', () => {
  it('shows only the close control on a tab', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openFromList(user, 'Старое имя');

    // The label itself is the tab; beside it there must be exactly one control,
    // and it is the one that closes the document rather than destroying it.
    const tab = screen.getByRole('tab', { name: 'Старое имя' }).closest('.note-tab')!;
    const controls = within(tab as HTMLElement).getAllByRole('button');
    expect(controls.map((node) => node.getAttribute('aria-label')))
      .toEqual(['Закрыть Старое имя']);
    expect(within(tab as HTMLElement).queryByRole('button', { name: /^Удалить/ }))
      .not.toBeInTheDocument();
  });

  it('has no tools button: its two actions moved to the "+" menu and the text menu', () => {
    render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Инструменты' })).not.toBeInTheDocument();
  });

  it('does not rename on a double click, which fires while switching tabs', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openFromList(user, 'Старое имя');

    await user.dblClick(screen.getByRole('tab', { name: 'Старое имя' }));
    expect(screen.queryByLabelText('Название конспекта')).not.toBeInTheDocument();
  });
});

describe('renaming from the tab', () => {
  it('renames from the tab menu, without sending the text', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openFromList(user, 'Старое имя');

    const menu = await openTabMenu(user, 'Старое имя');
    await user.click(within(menu).getByRole('menuitem', { name: 'Переименовать' }));
    const field = await screen.findByLabelText('Название конспекта');
    await user.clear(field);
    await user.type(field, 'Новое имя{Enter}');

    await waitFor(() => expect(sent.some((req) => req.method === 'PATCH')).toBe(true));
    const rename = sent.find((req) => req.method === 'PATCH');
    expect(rename!.body).toMatchObject({ title: 'Новое имя' });
    // A rename is not an edit: the document's text must not ride along.
    expect(rename!.body).not.toHaveProperty('content');
    expect(await screen.findByRole('tab', { name: 'Новое имя' })).toBeInTheDocument();
  });

  it('keeps the previous name when the field is cleared', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openFromList(user, 'Старое имя');

    const menu = await openTabMenu(user, 'Старое имя');
    await user.click(within(menu).getByRole('menuitem', { name: 'Переименовать' }));
    const field = await screen.findByLabelText('Название конспекта');
    await user.clear(field);
    await user.type(field, '   {Enter}');

    expect(sent.some((req) => req.method === 'PATCH')).toBe(false);
    expect(await screen.findByRole('tab', { name: 'Старое имя' })).toBeInTheDocument();
  });

  it('refuses both actions on a tab whose generation has produced no note yet', async () => {
    const user = userEvent.setup();
    seed([]);
    render(<NotesPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Создать конспект с ИИ/ }));
    const tab = await screen.findByRole('tab', { name: /Генерация|Старое имя/ });

    await user.pointer({ keys: '[MouseRight]', target: tab });
    const menu = await screen.findByRole('menu', { name: /^Конспект / });
    // There is no stored note to name or delete yet; both say so rather than
    // vanishing, so the user can see the actions exist.
    expect(within(menu).getByRole('menuitem', { name: /Переименовать/ })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: /Удалить/ })).toBeDisabled();
  });
});

describe('deleting from the tab', () => {
  it('deletes the open note from the tab menu and closes its tab', async () => {
    const user = userEvent.setup();
    seed([note(), note({ id: 'n2', title: 'Другая', content: 'другое тело' })]);
    render(<NotesPanel onCite={vi.fn()} />);
    await openFromList(user, 'Старое имя');

    const menu = await openTabMenu(user, 'Старое имя');
    await user.click(within(menu).getByRole('menuitem', { name: 'Удалить' }));

    await waitFor(() => expect(sent.some((req) =>
      req.method === 'DELETE' && req.path === '/sessions/s1/notes/n1')).toBe(true));
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'Старое имя' })).not.toBeInTheDocument());
    // The other note is untouched and still listed.
    expect(screen.getByRole('button', { name: 'Открыть Другая' })).toBeInTheDocument();
  });
});

describe('the save dot', () => {
  it('sits inside the active tab and nowhere else', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openFromList(user, 'Старое имя');
    // A second tab, so there is a background one to check against.
    await user.click(screen.getByRole('button', { name: 'Новый конспект' }));
    await user.click(screen.getByRole('menuitem', { name: 'Создать пустой' }));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));

    const active = screen.getByRole('tab', { selected: true }).closest('.note-tab')!;
    expect(within(active as HTMLElement).getByLabelText('Сохранено')).toBeInTheDocument();
    // One dot in the window, and it belongs to the document on screen.
    expect(screen.getAllByLabelText('Сохранено')).toHaveLength(1);
    const background = screen.getByRole('tab', { name: 'Старое имя' }).closest('.note-tab')!;
    expect(within(background as HTMLElement).queryByLabelText('Сохранено')).not.toBeInTheDocument();
  });
});

describe('the "+" menu carries the detail control', () => {
  it('remembers the chosen detail level', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Новый конспект' }));
    await user.click(screen.getByRole('radio', { name: 'Подробно' }));
    expect(localStorage.getItem('audiohelper.noteDetail')).toBe('detailed');
    expect(screen.getByRole('radio', { name: 'Подробно' })).toHaveAttribute('aria-checked', 'true');
  });
});
