import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Citation, Note } from '../../api/types';
import { editorText } from '../../test/noteEditor';
import { OPEN_SETTINGS_EVENT } from '../../lib/openSettings';

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
    noteGenerations: {},
    notesError: null,
    settings: null,
  });
};

/** Open the note in a tab the way a user does: "+" → "Open existing". */
const openFirstNote = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'New notes' }));
  await user.click(screen.getByRole('menuitem', { name: 'Open existing' }));
  // Scoped to the picker: the session's own note list shows the same names
  // behind the dialog, and an unscoped query cannot tell the two apart.
  const picker = await screen.findByRole('dialog', { name: 'Open notes' });
  const entry = await within(picker)
    .findByRole('button', { name: /Some notes content|Без названия|Заголовок/ });
  await user.click(entry);
};


beforeEach(() => {
  localStorage.clear();
  useStore.setState({ noteTabs: {}, noteGenerations: {} });
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
    expect(screen.getByRole('button', { name: /Create AI notes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create empty' })).toBeInTheDocument();
  });

  it('disables AI generation with the reason on the button when there is no transcript', () => {
    useStore.setState({
      detail: { segments: [], messages: [], notes: null, notes_list: [] } as never,
    });
    render(<NotesPanel onCite={vi.fn()} />);
    const generate = screen.getByRole('button', { name: /Create AI notes/ });
    expect(generate).toBeDisabled();
    expect(generate).toHaveTextContent('No transcript');
    // The empty note never depends on the recording.
    expect(screen.getByRole('button', { name: 'Create empty' })).toBeEnabled();
  });

  it('states a missing notes model on the button instead of a banner over the pane', () => {
    useStore.setState({ settings: { notes: { model: '' } } as never });
    render(<NotesPanel onCite={vi.fn()} />);
    const generate = screen.getByRole('button', { name: /Create AI notes/ });
    expect(generate).toBeDisabled();
    expect(generate).toHaveTextContent('No model selected');
    expect(screen.queryByText(/Модель для конспектов не выбрана/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create empty' })).toBeEnabled();
  });

  it('offers the way into the Notes settings when no notes model is chosen', async () => {
    const opened: string[] = [];
    const onOpen = (event: Event) => opened.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    useStore.setState({ settings: { notes: { model: '' } } as never });
    render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.getByText('No model selected for notes.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(opened).toEqual(['notes']);
    window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  });

  it('shows no settings notice while settings are unread or a model is chosen', () => {
    const view = render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument();
    view.unmount();
    useStore.setState({ settings: { notes: { model: 'm' } } as never });
    render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument();
  });

  it('enables AI generation for a native recording whose summary omits segments', () => {
    // The native summary (`native_window=true`) never carries segments; the
    // server's has_transcript is the only honest answer there.
    useStore.setState({
      detail: { segments: [], has_transcript: true, messages: [], notes: null, notes_list: [] } as never,
    });
    render(<NotesPanel onCite={vi.fn()} />);
    const generate = screen.getByRole('button', { name: /Create AI notes/ });
    expect(generate).toBeEnabled();
    expect(generate).not.toHaveTextContent('No transcript');
  });

  it('keeps generation refused when the server says there is no transcript', () => {
    useStore.setState({
      detail: { segments: [], has_transcript: false, messages: [], notes: null, notes_list: [] } as never,
    });
    render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Create AI notes/ })).toBeDisabled();
  });

  it('opens generation once the post-Stop re-read reports final speech', async () => {
    const base = window.audiohelper.request;
    window.audiohelper = {
      ...window.audiohelper,
      request: (async (req: { method?: string; path: string }) => {
        if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
          return { ok: true, status: 200, data: {
            segments: [], has_transcript: true, messages: [], notes: null, notes_list: [],
          } };
        }
        return base(req as never);
      }) as never,
    };
    useStore.setState({
      detail: { segments: [], has_transcript: false, messages: [], notes: null, notes_list: [] } as never,
    });
    render(<NotesPanel onCite={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create AI notes/ })).toBeEnabled());
  });

  it('says to stop the recording rather than silently refusing while capturing', () => {
    useStore.setState({ recorderState: 'recording' });
    render(<NotesPanel onCite={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Create AI notes/ }))
      .toHaveTextContent('Stop recording first');
  });
});

describe('NotesPanel tabs', () => {
  it('shows a note formatted, with the Markdown kept as the stored source', async () => {
    const user = userEvent.setup();
    seed(note({ content: '# Заголовок\n\nSome notes content.' }));
    render(<NotesPanel onCite={vi.fn()} />);
    await openFirstNote(user);
    // It reads as a document: a heading line, no visible "#"…
    const doc = await screen.findByLabelText('Notes');
    expect(doc.querySelector('.cm-md-h1')).toHaveTextContent('Заголовок');
    expect(doc.textContent).not.toContain('#');
    // …while the text itself stays plain Markdown and is editable in place.
    expect(editorText(doc)).toBe('# Заголовок\n\nSome notes content.');
    expect(doc).toHaveAttribute('contenteditable', 'true');
    // No mode to enter and no replace action: both were removed on purpose.
    expect(screen.queryByRole('button', { name: 'Редактировать' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Заменить текущую' })).not.toBeInTheDocument();
  });

  it('closes a tab and returns to the start screen when it was the last one', async () => {
    const user = userEvent.setup();
    seed(note());
    render(<NotesPanel onCite={vi.fn()} />);
    await openFirstNote(user);
    await user.click(await screen.findByRole('button', { name: /^Close / }));
    expect(screen.queryByLabelText('Notes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create empty' })).toBeInTheDocument();
  });

  it('keeps the open tabs across a remount, which is what a restart looks like', async () => {
    const user = userEvent.setup();
    seed(note());
    const first = render(<NotesPanel onCite={vi.fn()} />);
    await openFirstNote(user);
    await screen.findByLabelText('Notes');
    first.unmount();

    render(<NotesPanel onCite={vi.fn()} />);
    expect(await screen.findByLabelText('Notes')).toHaveTextContent('Some notes content.');
  });
});

describe('NotesPanel tools menu', () => {
  it('offers only the tools that actually work', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'New notes' }));
    expect(screen.getByRole('menuitem', { name: /Create AI notes/ })).toBeInTheDocument();
    // Translation and restyling are planned but unimplemented; a greyed-out entry
    // would make a working app look broken.
    expect(screen.queryByRole('menuitem', { name: /Перевод/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Стиль/ })).not.toBeInTheDocument();
  });

  it('remembers the chosen detail level', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'New notes' }));
    await user.click(screen.getByRole('radio', { name: 'Detailed' }));
    expect(localStorage.getItem('audiohelper.noteDetail')).toBe('detailed');
    expect(screen.getByRole('radio', { name: 'Detailed' })).toHaveAttribute('aria-checked', 'true');
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
    await user.click(screen.getByRole('button', { name: 'New notes' }));
    await user.click(screen.getByRole('radio', { name: 'Brief' }));
    await user.click(screen.getByRole('menuitem', { name: /Create AI notes/ }));
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
    await screen.findByLabelText('Notes');
    expect(document.querySelector('details.notes__sources')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sources \(/)).not.toBeInTheDocument();
    expect(document.querySelector('[data-cited]')).not.toBeInTheDocument();
  });

  // The actions over a selection — their availability, the jump, Ask, and the
  // regeneration flow — live in NotesPanel.rewrite.test.tsx, where the menu that
  // now carries them is driven the way a user raises it: a right click.
});
