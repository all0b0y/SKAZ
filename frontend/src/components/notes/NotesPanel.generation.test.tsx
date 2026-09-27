import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Note } from '../../api/types';

// Regressions for "the note came back from the model but never loaded"
// (docs/NOTES-POLISH-SPEC.md): the tab was bound to the note inside the panel,
// so leaving the pane or the session mid-generation stranded the result.

const segments = [{ id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' }];
const generated: Note = {
  id: 'gen', revision: 1, content: '# Итог\n\nТекст конспекта',
  created_at: '2026-01-01T00:00:00Z', model: 'm', citations: [],
};

interface Pending { resolve: () => void; reject: () => void }
let pending: Pending[];
let notesBySession: Record<string, Note[]>;

const selectLoaded = (sessionId: string) => useStore.setState({
  activeSessionId: sessionId,
  detailLoading: false,
  detail: { segments, messages: [], notes: null, notes_list: notesBySession[sessionId] ?? [] } as never,
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  pending = [];
  notesBySession = {};
  window.skaz = {
    ...window.skaz,
    request: async <T,>(req: { method?: string; path: string }) => {
      const session = /\/sessions\/([^/]+)/.exec(req.path)?.[1] ?? '';
      if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
        return { ok: true, status: 200, data: {
          segments, messages: [], notes: null, notes_list: notesBySession[session] ?? [],
        } as T };
      }
      if (req.method === 'POST' && req.path.endsWith('/notes')) {
        return new Promise((resolve) => {
          pending.push({
            resolve: () => {
              notesBySession[session] = [generated, ...(notesBySession[session] ?? [])];
              resolve({ ok: true, status: 200, data: generated as T });
            },
            reject: () => resolve({ ok: false, status: 502, data: { detail: 'Модель не ответила' } as T }),
          });
        });
      }
      return { ok: true, status: 200, data: {} as T };
    },
  } as never;
  useStore.setState({
    sessions: [
      { id: 's1', title: 'Лекция А', created_at: '2026-01-01T00:00:00Z' } as never,
      { id: 's2', title: 'Лекция Б', created_at: '2026-01-01T00:00:00Z' } as never,
    ],
    recorderState: 'stopped',
    settings: { notes: { model: 'm' } } as never,
    notesError: null,
    noteTabs: {},
    noteGenerations: {},
  });
  selectLoaded('s1');
});

const startGeneration = async () => {
  const user = userEvent.setup();
  await user.click(screen.getAllByRole('button', { name: /Create AI notes/ })[0]!);
  await waitFor(() => expect(pending).toHaveLength(1));
};

describe('generated note loading', () => {
  it('shows the note after the user left the Notes pane mid-generation', async () => {
    const view = render(<NotesPanel onCite={vi.fn()} />);
    await startGeneration();
    view.unmount();
    pending[0]!.resolve();
    await waitFor(() => expect(useStore.getState().noteGenerations.s1).toBeUndefined());

    render(<NotesPanel onCite={vi.fn()} />);
    expect(await screen.findByText('Текст конспекта')).toBeInTheDocument();
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Итог');
  });

  it('binds the note to its own session when the user switched session', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    await startGeneration();
    selectLoaded('s2');
    pending[0]!.resolve();
    await waitFor(() => expect(useStore.getState().noteGenerations.s1).toBeUndefined());

    // Session B never received A's tab, and no failure was invented for A.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();

    selectLoaded('s1');
    expect(await screen.findByText('Текст конспекта')).toBeInTheDocument();
  });

  it('keeps each session to its own tabs', async () => {
    useStore.setState({ noteTabs: {
      s1: { tabs: [{ id: 'a', sessionId: 's1', noteId: 'gen', title: 'Итог' }], activeTabId: 'a' },
    } });
    notesBySession.s1 = [generated];
    selectLoaded('s1');
    render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Итог' })).toBeInTheDocument();

    selectLoaded('s2');
    await waitFor(() => expect(screen.queryByRole('tab')).not.toBeInTheDocument());
    selectLoaded('s1');
    expect(await screen.findByRole('tab', { name: 'Итог' })).toBeInTheDocument();
  });

  it('lets another session generate while one is running', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    await startGeneration();
    selectLoaded('s2');
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /Create AI notes/ });
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(pending).toHaveLength(2));
  });

  it('refuses a second generation in the same session while one runs', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    await startGeneration();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New notes' }));
    expect(screen.getByRole('menuitem', { name: /Generating…|Create AI notes/ })).toBeDisabled();
  });

  it('shows a real failure in its tab and retries there', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    await startGeneration();
    pending[0]!.reject();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    pending[1]!.resolve();
    expect(await screen.findByText('Текст конспекта')).toBeInTheDocument();
  });

  it('closing a running tab hides it; the note still lands in the list', async () => {
    render(<NotesPanel onCite={vi.fn()} />);
    await startGeneration();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Close Generating…' }));
    pending[0]!.resolve();
    await waitFor(() => expect(useStore.getState().detail?.notes_list).toHaveLength(1));
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Open Итог/ })).toBeInTheDocument();
  });
});

describe('session list marker', () => {
  it('marks the session whose note is still being generated', async () => {
    const { SessionNavigator } = await import('../sessions/SessionNavigator');
    render(<><NotesPanel onCite={vi.fn()} /><SessionNavigator /></>);
    await startGeneration();
    const busy = screen.getAllByRole('status', { name: 'Notes are being generated' });
    expect(busy).toHaveLength(1);
    pending[0]!.resolve();
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Notes are being generated' })).not.toBeInTheDocument());
  });
});
