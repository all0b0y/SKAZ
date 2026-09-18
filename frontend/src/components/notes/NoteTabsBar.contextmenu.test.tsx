import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Note } from '../../api/types';

/**
 * One right click is one menu.
 *
 * Every menu in the app closes itself when a mouse button goes down outside it,
 * and the browser sends that button-down BEFORE the `contextmenu` that opens the
 * next one. Left unguarded, a right click on a second tab reads as "dismiss" and
 * the menu the user asked for never appears — they have to click twice. So the
 * dismissal ignores the right button, and opening a menu replaces whatever was
 * open rather than fighting with it.
 */

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'n1',
  revision: 1,
  content: 'тело заметки',
  title: 'Первая',
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
    detail: { segments: [transcript], messages: [], notes: list[0] ?? null, notes_list: list } as never,
    recorderState: 'stopped',
    notesGenerating: false,
    notesError: null,
    settings: { notes: { model: 'test-model' } } as never,
  });
};

/** Two documents already open, the way a returning user finds them. */
const seedTabs = () => {
  localStorage.setItem('audiohelper.noteTabs', JSON.stringify({
    tabs: [
      { id: 't1', sessionId: 's1', noteId: 'n1', title: 'Первая' },
      { id: 't2', sessionId: 's1', noteId: 'n2', title: 'Вторая' },
    ],
    activeTabId: 't2',
  }));
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  window.audiohelper = {
    ...window.audiohelper,
    request: async <T,>(req: { method?: string; path: string; body?: unknown }) => {
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
  seed([note(), note({ id: 'n2', title: 'Вторая', content: 'другое тело' })]);
});

describe('a right click always lands its own menu', () => {
  it('moves the menu to the second tab in one click', async () => {
    const user = userEvent.setup();
    seedTabs();
    render(<NotesPanel onCite={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('tab', { name: 'Первая' }) });
    expect(await screen.findByRole('menu', { name: 'Конспект «Первая»' })).toBeInTheDocument();

    // The second right click must not be spent dismissing the first menu.
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('tab', { name: 'Вторая' }) });
    expect(await screen.findByRole('menu', { name: 'Конспект «Вторая»' })).toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: 'Конспект «Первая»' })).not.toBeInTheDocument();
  });

  it('never leaves two menus open at once', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Открыть Первая' }));
    await screen.findByLabelText('Конспект');

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('tab', { name: 'Первая' }) });
    await screen.findByRole('menu', { name: 'Конспект «Первая»' });

    // A right click on the document raises the text menu; the tab's must go.
    await user.pointer({ keys: '[MouseRight]', target: screen.getByLabelText('Конспект') });
    await screen.findByRole('menu', { name: 'Действия с фрагментом' });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });
});
