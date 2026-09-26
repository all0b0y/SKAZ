import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Note } from '../../api/types';
import type { SharedNote } from '../../api/bridge';

// Spec CODEX-NOTES-FIX §5-6: «Поделиться…» on the tab's right-click menu hands a
// clean `.md` (title + text, no service tail) to the system share sheet, saving
// pending edits first. The bridge is a test double: this checks the renderer's
// side, not that macOS actually shows its sheet.

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'n1', revision: 1, content: 'Первая мысль.', title: 'Устойчивость',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  model: 'm', citations: [], ...overrides,
});

let shared: SharedNote[];
let patches: string[];

const install = (platform: string, share = true) => {
  shared = [];
  patches = [];
  window.audiohelper = {
    ...window.audiohelper,
    platform,
    shareNote: share ? async (payload: SharedNote) => { shared.push(payload); return true; } : undefined,
    request: async <T,>(req: { method?: string; path: string; body?: unknown }) => {
      if (req.method === 'PATCH') {
        const body = req.body as { content?: string };
        patches.push(body.content ?? '');
        return { ok: true, status: 200, data: note({ revision: 2, ...body }) as T };
      }
      return { ok: true, status: 200, data: { notes: [] } as T };
    },
  } as never;
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  install('darwin');
  useStore.setState({
    activeSessionId: 's1',
    sessions: [{ id: 's1', title: 'Лекция 1', created_at: 't' } as never],
    detail: { segments: [{ id: 'x', start_ms: 0, end_ms: 1, text: 'hi' }], messages: [],
      notes: note(), notes_list: [note()] } as never,
    recorderState: 'stopped', noteGenerations: {}, notesError: null,
    settings: { notes: { model: 'm' } } as never,
    noteTabs: { s1: { tabs: [{ id: 't1', sessionId: 's1', noteId: 'n1', title: 'Устойчивость' }], activeTabId: 't1' } },
  });
});

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('tab', { name: 'Устойчивость' }) });
  return screen.findByRole('menu', { name: 'Notes “Устойчивость”' });
};

describe('share a note from its tab', () => {
  it('offers “Share…” above “Rename” and sends a clean file', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    const menu = await openMenu(user);
    const items = [...menu.querySelectorAll('[role=menuitem] > span')].map((s) => s.textContent);
    expect(items.slice(0, 2)).toEqual(['Share…', 'Rename']);
    await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
    await waitFor(() => expect(shared).toHaveLength(1));
    expect(shared[0]).toMatchObject({ fileName: 'Устойчивость', content: '# Устойчивость\n\nПервая мысль.\n' });
  });

  it('saves the text on screen first and shares exactly that', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    const editor = await screen.findByLabelText('Notes');
    await user.click(editor);
    await user.keyboard('{Control>}{End}{/Control} Правка.');
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
    await waitFor(() => expect(shared).toHaveLength(1));
    expect(patches.at(-1)).toContain('Правка.');
    expect(shared[0]!.content).toContain('Правка.');
  });

  it('is visible but disabled, with the reason, where no share sheet exists', async () => {
    install('win32');
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openMenu(user);
    const item = screen.getByRole('menuitem', { name: /Share…/ });
    expect(item).toBeDisabled();
    expect(item).toHaveTextContent('Available on macOS only');
  });

  it('is disabled while the note is still being generated', async () => {
    useStore.setState({ noteTabs: { s1: {
      tabs: [{ id: 't1', sessionId: 's1', noteId: null, title: 'Устойчивость' }], activeTabId: 't1' } } });
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openMenu(user);
    const item = screen.getByRole('menuitem', { name: /Share…/ });
    expect(item).toBeDisabled();
    expect(item).toHaveTextContent('The notes are not created yet');
  });
});
