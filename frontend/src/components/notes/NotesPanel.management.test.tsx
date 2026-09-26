import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BridgeApi, BridgeRequest, JsonResponse } from '../../api/bridge';
import type { Note } from '../../api/types';

let Panel: typeof import('./NotesPanel')['NotesPanel'];
// Loaded after vi.resetModules() with the panel, so it drives the same CodeMirror
// module instance the editor was built with.
let editing: typeof import('../../test/noteEditor');
let requests: BridgeRequest[];
const first: Note = {
  id: 'n1', revision: 1, content: '# Первая заметка\nТекст.',
  created_at: '2026-01-01T00:00:00Z', model: 'fixture', citations: [],
};
const second: Note = { ...first, id: 'n2', content: '# Вторая заметка' };

/** The open note's editor: always editable, no mode to enter first. */
const openEditor = () => screen.findByLabelText('Notes');

/** CodeMirror's "Mod": ⌘ on macOS (the app), Ctrl elsewhere (jsdom's platform). */
const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  localStorage.clear();
  requests = [];
  const request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
    requests.push(req);
    const body = req.body as { content?: string } | undefined;
    if (req.method === 'PATCH') {
      return { ok: true, status: 200, data: { ...first, revision: 2, content: body?.content } as T };
    }
    if (req.path.endsWith('/notes/empty')) {
      return { ok: true, status: 200, data: { ...first, id: 'n-empty', content: '' } as T };
    }
    if (req.method === 'GET' && req.path.endsWith('/notes')) {
      return { ok: true, status: 200, data: { notes: [second, first] } as T };
    }
    if (req.method === 'POST') {
      return { ok: true, status: 200, data: { ...first, id: 'n3', content: '# Сгенерировано' } as T };
    }
    return { ok: false, status: 404, detail: 'No fixture' };
  };
  window.audiohelper = { ...window.audiohelper, request } satisfies BridgeApi;
  const { useStore } = await import('../../state/store');
  await act(async () => useStore.setState({
    activeSessionId: 's1', recorderState: 'paused', noteTabs: {}, noteGenerations: {}, notesError: null,
    sessions: [{ id: 's1', title: 'Лекция', created_at: '2026-01-01T00:00:00Z' }] as never,
    detail: { notes: second, notes_list: [second, first], messages: [],
      segments: [{ id: 'seg1', start_ms: 0, end_ms: 1000, text: 'Transcript' }] } as never,
  }));
  Panel = (await import('./NotesPanel')).NotesPanel;
  editing = await import('../../test/noteEditor');
});

it('creates an empty note without touching the transcript or any model', async () => {
  const user = userEvent.setup();
  render(<Panel onCite={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Create empty' }));
  // An empty note opens ready to type rather than as a blank page to read.
  await waitFor(() => expect(screen.getByLabelText('Notes')).toBeInTheDocument());
  // A transcript re-read is allowed (it is a plain GET); what must not happen is
  // a generation, so no POST may reach the notes endpoint but the empty one.
  expect(requests.filter((req) => req.method === 'POST').map((req) => req.path))
    .toEqual(['/sessions/s1/notes/empty']);
  expect(requests.some((req) => req.path === '/sessions/s1/notes')).toBe(false);
});

it('opens a generated note in its own tab without replacing what is already open', async () => {
  const user = userEvent.setup();
  render(<Panel onCite={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Create empty' }));
  await waitFor(() => expect(screen.getByLabelText('Notes')).toBeInTheDocument());

  await user.click(screen.getByRole('button', { name: 'New notes' }));
  await user.click(screen.getByRole('menuitem', { name: 'Create AI notes' }));
  await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
  // The generation request must never ask the backend to overwrite a note.
  const generation = requests.find((req) => req.path === '/sessions/s1/notes');
  expect(generation?.body).not.toHaveProperty('replace_note_id');
});

it('autosaves an edit without any save button being pressed', async () => {
  const user = userEvent.setup();
  render(<Panel onCite={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Create empty' }));
  const editor = await openEditor();
  editing.typeAtEnd(editor, 'Мои правки');

  await waitFor(
    () => expect(requests.some((req) => req.method === 'PATCH')).toBe(true),
    { timeout: 4_000 },
  );
  const saved = requests.filter((req) => req.method === 'PATCH').at(-1);
  expect(saved).toMatchObject({ path: '/sessions/s1/notes/n-empty' });
  expect((saved?.body as { content: string }).content).toContain('Мои правки');
}, 10_000);

it('saves immediately on Cmd+S rather than waiting out the idle delay', async () => {
  const user = userEvent.setup();
  render(<Panel onCite={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Create empty' }));
  const editor = await openEditor();
  editing.typeAtEnd(editor, 'Срочно');
  fireEvent.keyDown(editing.editorView(editor).contentDOM, { key: 's', ...mod });
  await waitFor(() => expect(requests.some((req) => req.method === 'PATCH')).toBe(true));
});

it('reports the save state as a quiet dot rather than a line of text', async () => {
  const user = userEvent.setup();
  render(<Panel onCite={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Create empty' }));
  const editor = await openEditor();
  expect(screen.getByLabelText('Saved')).toHaveClass('note-tab__save');
  // No prose and no button: the old "Saved"/"Not saved" control is gone.
  expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
  act(() => editing.typeAtEnd(editor, 'x'));
  expect(screen.getByLabelText('Not saved')).toHaveClass('note-tab__save');
});

it('never shows a staleness banner over a note the recording moved past', async () => {
  const { useStore } = await import('../../state/store');
  const detail = useStore.getState().detail!;
  await act(async () => useStore.setState({
    detail: { ...detail, notes_list: [{ ...second, stale: true }, first] },
  }));
  const user = userEvent.setup();
  render(<Panel onCite={() => {}} />);
  expect(screen.queryByText(/Заметка устарела/)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'New notes' }));
  await user.click(screen.getByRole('menuitem', { name: 'Open existing' }));
  const picker = await screen.findByRole('dialog', { name: 'Open notes' });
  await user.click(await within(picker).findByRole('button', { name: /Вторая заметка/ }));
  await screen.findByLabelText('Notes');
  expect(screen.queryByText(/Заметка устарела/)).not.toBeInTheDocument();
  // Still never regenerated behind the user's back.
  expect(requests.some((req) => req.method === 'POST')).toBe(false);
});

it('offers only this session\'s notes in the picker (docs/NOTES-POLISH-SPEC.md §3)', async () => {
  const user = userEvent.setup();
  render(<Panel onCite={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'New notes' }));
  await user.click(screen.getByRole('menuitem', { name: 'Open existing' }));
  const picker = await screen.findByRole('dialog', { name: 'Open notes' });
  expect(within(picker).getAllByRole('button', { name: /заметка/ })).toHaveLength(2);
  // No other session is read: the list is the one this pane already holds.
  expect(requests.filter((req) => req.method === 'GET' && req.path.endsWith('/notes'))).toHaveLength(0);
});
