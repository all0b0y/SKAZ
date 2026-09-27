import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import { stopCodexPolling, useCodex } from '../../state/codex';
import { fakeCodex, type FakeCodex } from '../../test/codexFake';

// Notes generation through Codex against the authored contract fixture: the
// task runs app-wide, the note lands in the tab that waited for it, an
// interrupted task waits for "Continue". Not a real backend/Codex run.

const initialCodex = useCodex.getState();
const originalBridge = window.skaz;
let fake: FakeCodex;

beforeEach(async () => {
  localStorage.clear();
  useCodex.setState(initialCodex, true);
  fake = fakeCodex();
  Object.defineProperty(window, 'skaz', { configurable: true, writable: true, value: fake.bridge });
  useStore.setState({
    ready: true, activeSessionId: 's1', detailLoading: false, notesError: null, noteTabs: {}, noteGenerations: {},
    sessions: [{ id: 's1', title: 'Лекция', created_at: 't', status: 'recording', duration_ms: 1, mode: 'legacy' }],
    // Recording on purpose: Codex reads a confirmed snapshot, not the stopped file.
    recorderState: 'recording',
    settings: { notes: { provider: 'openrouter', model: '' }, output_language: 'ru' } as never,
    detail: { segments: [], messages: [], notes: null, notes_list: [], has_transcript: true },
  });
  await act(() => useCodex.getState().load('s1'));
});

afterEach(() => {
  stopCodexPolling();
  Object.defineProperty(window, 'skaz', { configurable: true, writable: true, value: originalBridge });
});

const poll = () => act(() => useCodex.getState().poll());

describe('Notes engine choice', () => {
  it('uses the API notes profile when only Assistant runs on Codex', async () => {
    fake.settings.notes_enabled = false;
    await act(() => useCodex.getState().load('s1'));
    useStore.setState({ recorderState: 'idle', settings: { notes: { provider: 'openrouter', model: 'notes-model' }, output_language: 'ru' } as never });
    const user = userEvent.setup();
    render(<NotesPanel onCite={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Create AI notes' }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/sessions/s1/notes')).toBe(true));
    expect(fake.calls.some((c) => c.path === '/codex/sessions/s1/notes')).toBe(false);
  });

  it('uses Codex for Notes when Assistant stays on its API profile', async () => {
    fake.settings.assistant_enabled = false;
    await act(() => useCodex.getState().load('s1'));
    const user = userEvent.setup();
    render(<NotesPanel onCite={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Create AI notes' }));
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/codex/sessions/s1/notes')).toBe(true));
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/sessions/s1/notes')).toBe(false);
  });
});

describe('NotesPanel with Codex', () => {
  it('generates for this session only, shows real activity and binds the finished note to its tab', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Create AI notes' }));
    await waitFor(() => expect(fake.tasks).toHaveLength(1));
    const call = fake.calls.find((c) => c.path === '/codex/sessions/s1/notes')!;
    expect(call.body).toEqual({ language: 'ru', detail: 'normal' });
    expect(fake.calls.some((c) => c.path === '/sessions/s1/notes')).toBe(false);

    const task = fake.tasks[0]!;
    fake.update(task.id, { status: 'running', activity: ['Читаю 00:00–10:00'] });
    await poll();
    expect(screen.getByRole('status', { name: 'Generating notes' })).toHaveTextContent('Running · Codex is reading the whole recording · Читаю 00:00–10:00');

    fake.notes.push({ id: 'n9', revision: 1, content: '# Конспект', title: 'Конспект лекции', created_at: 't', model: 'gpt-x', citations: [] });
    fake.update(task.id, { status: 'completed', note_id: 'n9' });
    await poll();
    await waitFor(() => expect(useStore.getState().noteGenerations.s1).toBeUndefined());
    const tabs = useStore.getState().noteTabs.s1!;
    expect(tabs.tabs.find((t) => t.id === tabs.activeTabId)).toMatchObject({ noteId: 'n9', title: 'Конспект лекции' });
    expect(useStore.getState().detail?.notes_list?.map((n) => n.id)).toEqual(['n9']);
  });

  it('keeps an interrupted generation unfinished and resumes it only on click', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Create AI notes' }));
    await waitFor(() => expect(fake.tasks).toHaveLength(1));
    const task = fake.tasks[0]!;
    fake.update(task.id, { status: 'paused', answer: 'Первая половина' });
    await poll();
    expect(await screen.findByRole('alert')).toHaveTextContent('Generation was interrupted and waits to be resumed manually.');
    expect(screen.getByText(/Partial text was not saved as a note/)).toBeInTheDocument();
    expect(fake.calls.some((c) => c.path.endsWith('/resume'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(fake.task(task.id).status).toBe('queued');
    expect(screen.getByRole('status', { name: 'Generating notes' })).toBeInTheDocument();
  });

  it('stops a running generation on request', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Create AI notes' }));
    await waitFor(() => expect(fake.tasks).toHaveLength(1));
    fake.update(fake.tasks[0]!.id, { status: 'running' });
    await poll();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(fake.calls.some((c) => c.path.endsWith('/stop'))).toBe(true);
  });

  it('refuses to start without a Codex notes model instead of using the old generator', async () => {
    await act(() => useCodex.getState().saveSettings({ ...fake.settings, notes_model: '' }));
    render(<NotesPanel onCite={() => undefined} />);
    expect(screen.getByRole('button', { name: /Create AI notes/ })).toBeDisabled();
    expect(screen.getByText('No model selected')).toBeInTheDocument();
  });
});
