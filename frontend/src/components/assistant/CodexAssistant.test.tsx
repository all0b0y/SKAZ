import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantPanel } from './AssistantPanel';
import { useStore } from '../../state/store';
import { stopCodexPolling, useCodex } from '../../state/codex';
import { fakeCodex, type FakeCodex } from '../../test/codexFake';
import type { BridgeApi } from '../../api/bridge';
import type { Session } from '../../api/types';

// UI mechanics against an authored contract fixture (src/test/codexFake.ts).
// Not evidence that the real backend or Codex work end to end.

const initialCodex = useCodex.getState();
const originalBridge = window.audiohelper;
const sessions: Session[] = [
  { id: 's1', title: 'Лекция 1', created_at: 't', status: 'stopped', duration_ms: 1000, mode: 'legacy' },
  { id: 's2', title: 'Лекция 2', created_at: 't', status: 'stopped', duration_ms: 1000, mode: 'legacy' },
];

let fake: FakeCodex;
const install = (bridge: BridgeApi) => {
  Object.defineProperty(window, 'audiohelper', { configurable: true, writable: true, value: bridge });
};
const poll = () => act(() => useCodex.getState().poll());

beforeEach(() => {
  useCodex.setState(initialCodex, true);
  fake = fakeCodex();
  install(fake.bridge);
  useStore.setState({
    ready: true, activeSessionId: 's1', sessions, askContext: null, asking: false, askError: null, chatScope: 'session',
    detail: { segments: [], messages: [], notes: null, notes_list: [] },
  });
});

afterEach(() => {
  stopCodexPolling();
  install(originalBridge);
});

async function renderPanel() {
  const utils = render(<AssistantPanel onCite={vi.fn()} onOpenSettings={vi.fn()} />);
  await waitFor(() => expect(useCodex.getState().availability).toBe('available'));
  return utils;
}

describe('Assistant engine choice', () => {
  it('keeps the existing assistant when the backend does not serve the Codex boundary', async () => {
    install({ ...fake.bridge, request: vi.fn(async () => ({ ok: false, status: 404, detail: 'Not Found' })) } as BridgeApi);
    render(<AssistantPanel onCite={vi.fn()} />);
    await waitFor(() => expect(useCodex.getState().availability).toBe('unavailable'));
    expect(screen.getByRole('button', { name: 'Search · Session' })).toBeInTheDocument();
  });

  it('keeps the existing assistant while Codex is served but switched off', async () => {
    fake.settings.assistant_enabled = false;
    fake.settings.notes_enabled = false;
    await renderPanel();
    expect(screen.getByRole('button', { name: 'Search · Session' })).toBeInTheDocument();
  });

  it('uses the API assistant when only Notes run on Codex', async () => {
    fake.settings.assistant_enabled = false;
    await renderPanel();
    expect(screen.getByRole('button', { name: 'Search · Session' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Chat scope: Session')).not.toBeInTheDocument();
  });

  it('uses Codex for Assistant when only Assistant runs on it', async () => {
    fake.settings.notes_enabled = false;
    await renderPanel();
    expect(screen.getByLabelText('Chat scope: Session')).toBeInTheDocument();
  });

  it('reads a legacy single switch from an older backend as Codex for Assistant', async () => {
    const { assistant_enabled: _a, notes_enabled: _n, ...rest } = fake.settings;
    fake.settings = { ...rest, enabled: true } as never;
    await renderPanel();
    expect(screen.getByLabelText('Chat scope: Session')).toBeInTheDocument();
    expect(useCodex.getState().settings).toMatchObject({ assistant_enabled: true, notes_enabled: true });
    expect(useCodex.getState().settings).not.toHaveProperty('enabled');
  });

  it('asks for a Codex model instead of sending when Assistant has none', async () => {
    fake.settings.assistant_model = '';
    fake.settings.assistant_effort = '';
    await renderPanel();
    expect(screen.getByText(/Choose a Codex model and reasoning effort for Assistant/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
  });

  it('does not fall back to the old engine when the Codex state cannot be read', async () => {
    install({ ...fake.bridge, request: vi.fn(async () => ({ ok: false, status: 500, detail: 'boom' })) } as BridgeApi);
    render(<AssistantPanel onCite={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the Codex status: boom');
    // The shared shell stays, but nothing can be typed or sent.
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send question' })).toBeDisabled();
  });
});

describe('Codex chats', () => {
  it('opens a Session chat on the first question and streams the cumulative answer', async () => {
    const user = userEvent.setup();
    await renderPanel();
    expect(screen.getByLabelText('Chat scope: Session')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Что было в начале?{Enter}');

    const chat = fake.chats[0]!;
    expect(chat.scope).toBe('session');
    const task = fake.tasks[0]!;
    expect(task.question).toBe('Что было в начале?');
    expect(screen.getByText('Queued')).toBeInTheDocument();

    fake.update(task.id, { status: 'running', answer: 'Сначала', activity: ['Читаю 00:00–05:00'] });
    await poll();
    expect(screen.getByText('Сначала')).toBeInTheDocument();
    expect(screen.getByText('· Читаю 00:00–05:00')).toBeInTheDocument();
    // Replacement, not append.
    fake.update(task.id, { answer: 'Сначала обсуждали бюджет' });
    await poll();
    expect(screen.getByText('Сначала обсуждали бюджет')).toBeInTheDocument();
    expect(screen.queryByText(/^Сначала$/)).not.toBeInTheDocument();

    fake.update(task.id, { status: 'completed' });
    fake.messages[chat.id]!.push({ id: 'a1', role: 'assistant', content: 'Сначала обсуждали бюджет.', created_at: 't', citations: [] });
    await poll();
    expect(screen.queryByTestId('codex-task')).not.toBeInTheDocument();
    expect(screen.getByText('Сначала обсуждали бюджет.')).toBeInTheDocument();
    expect(screen.getAllByText('Что было в начале?')).toHaveLength(1);
  });

  it('steers the running task instead of starting another, and stops on request', async () => {
    const user = userEvent.setup();
    await renderPanel();
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Объясни термин{Enter}');
    const task = fake.tasks[0]!;
    fake.update(task.id, { status: 'running' });
    await poll();
    const steer = screen.getByRole('textbox', { name: 'Refinement for the current task' });
    expect(steer).toHaveAttribute('placeholder', 'Refine the current task…');
    await user.type(steer, 'Проще{Enter}');
    expect(fake.tasks).toHaveLength(1);
    expect(fake.messages[fake.chats[0]!.id]!.map((m) => m.content)).toEqual(['Объясни термин', 'Проще']);

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(fake.calls.some((c) => c.path === `/codex/tasks/${task.id}/stop`)).toBe(true);
    expect(screen.getByText('Stopping')).toBeInTheDocument();
  });

  it('restores a paused task as unfinished and resumes only on a click', async () => {
    const chat = { id: 'c9', session_id: 's1', title: 'Старый', scope: 'session' as const, group_id: null, revoked: false, unread: false, updated_at: 't' };
    fake.chats.push(chat);
    fake.messages.c9 = [{ id: 'u', role: 'user', content: 'Полный конспект?', created_at: 't' }];
    fake.tasks.push({ id: 'tp', chat_id: 'c9', session_ids: ['s1'], question: 'Полный конспект?', model: 'gpt-x',
      status: 'paused', snapshot_id: 'snap', answer: 'Первая часть', error: null, kind: 'chat', note_id: null,
      citations: [], activity: ['Читаю 00:00–10:00'] });
    fake.selected.s1 = 'c9';
    const user = userEvent.setup();
    await renderPanel();
    await screen.findByText('Первая часть');
    expect(screen.getByText(/Answer unfinished/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
    expect(fake.calls.some((c) => c.path.endsWith('/resume'))).toBe(false);

    await user.click(screen.getByText(/Activity log · 1/));
    expect(screen.getByText('Читаю 00:00–10:00')).toBeVisible();
    const card = screen.getByTestId('codex-task');
    await user.click(within(card).getByRole('button', { name: 'Continue' }));
    expect(fake.calls.filter((c) => c.path === '/codex/tasks/tp/resume')).toHaveLength(1);
    expect(fake.task('tp').status).toBe('queued');
  });

  it('lets a paused task be cancelled from its chat, freeing the composer', async () => {
    fake.chats.push({ id: 'c9', session_id: 's1', title: 'Старый', scope: 'session', group_id: null, revoked: false, unread: false, updated_at: 't' });
    fake.messages.c9 = [];
    fake.tasks.push({ id: 'tp', chat_id: 'c9', session_ids: ['s1'], question: 'Q', model: 'gpt-x', status: 'paused',
      snapshot_id: null, answer: '', error: null, kind: 'chat', note_id: null, citations: [], activity: [] });
    fake.selected.s1 = 'c9';
    const user = userEvent.setup();
    await renderPanel();
    const card = await screen.findByTestId('codex-task');
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(fake.task('tp').status).toBe('cancelled');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Question' })).toBeEnabled());
  });

  it('reopens the chat last selected in the session', async () => {
    fake.chats.push(
      { id: 'a', session_id: 's1', title: 'Первый', scope: 'session', group_id: null, revoked: false, unread: false, updated_at: '1' },
      { id: 'b', session_id: 's1', title: 'Второй', scope: 'all', group_id: null, revoked: false, unread: true, updated_at: '2' },
    );
    fake.selected.s1 = 'a';
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Первый' })).toBeInTheDocument());
    expect(screen.getByLabelText('Chat scope: Session')).toBeInTheDocument();
  });

  it('creates chats with a fixed scope, lists them by activity, renames and deletes only after confirmation', async () => {
    fake.chats.push(
      { id: 'old', session_id: 's1', title: 'Давний', scope: 'session', group_id: null, revoked: false, unread: false, updated_at: '2026-01-01' },
      { id: 'mid', session_id: 's1', title: 'Недавний', scope: 'session', group_id: null, revoked: false, unread: true, updated_at: '2026-05-01' },
    );
    const user = userEvent.setup();
    await renderPanel();
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    const picker = screen.getByRole('dialog', { name: 'Chats' });
    const names = within(picker).getAllByRole('button').filter((b) => b.classList.contains('codex-picker__select'))
      .map((b) => b.querySelector('.codex-picker__name')!.textContent);
    expect(names).toEqual(['Недавний', 'Давний']);
    expect(within(picker).getByLabelText('New answer')).toBeInTheDocument();

    await user.click(within(picker).getByRole('button', { name: 'Group' }));
    await waitFor(() => expect(screen.getByLabelText('Chat scope: Group')).toBeInTheDocument());
    expect(fake.chats.at(-1)!.scope).toBe('group');

    await user.click(screen.getByRole('button', { name: 'New chat' }));
    await user.click(screen.getByRole('button', { name: 'Actions for chat Давний' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Chat name' });
    await user.clear(input);
    await user.type(input, 'Бюджет{Enter}');
    expect(fake.chats.find((c) => c.id === 'old')!.title).toBe('Бюджет');

    await user.click(screen.getByRole('button', { name: 'Actions for chat Бюджет' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(fake.chats.some((c) => c.id === 'old')).toBe(false));
    expect(fake.calls.find((c) => c.method === 'DELETE')!.query).toEqual({ confirmed: true });
  });

  it('keeps a revoked chat view-only and offers a new chat with current sources', async () => {
    fake.chats.push({ id: 'r', session_id: 's1', title: 'Группа А', scope: 'group', group_id: 'g', revoked: true, unread: false, updated_at: 't' });
    fake.messages.r = [{ id: 'm', role: 'assistant', content: 'Старый ответ', created_at: 't', citations: [] }];
    fake.selected.s1 = 'r';
    const user = userEvent.setup();
    await renderPanel();
    await screen.findByText('Старый ответ');
    expect(screen.getByText(/access was revoked/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'New chat · Group' }));
    await waitFor(() => expect(fake.chats.at(-1)!.scope).toBe('group'));
    expect(fake.chats.at(-1)!.id).not.toBe('r');
  });

  it('asks before a large job only when the backend requires it, and can stop asking', async () => {
    const user = userEvent.setup();
    await renderPanel();
    fake.failNextSend = { status: 428, detail: 'Будут прочитаны 12 записей группы целиком.' };
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Сравни все лекции{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Large task' });
    expect(dialog).toHaveTextContent('Будут прочитаны 12 записей группы целиком.');
    expect(fake.tasks).toHaveLength(0);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(fake.tasks).toHaveLength(1));
    expect(fake.settings.ask_before_large).toBe(false);
    const send = fake.calls.filter((c) => c.path.endsWith('/messages')).at(-1)!;
    expect(send.body).toEqual({ question: 'Сравни все лекции', confirmed_large: true });
  });

  it('blocks sending while Codex is missing or signed out and points to settings', async () => {
    fake.connection.status = 'signed_out';
    await renderPanel();
    expect(screen.getByText('No ChatGPT account connected.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Codex settings' })).toBeInTheDocument();
  });
});

describe('Codex queue', () => {
  it('shows every session’s tasks with cancel for waiting ones and resume for paused ones', async () => {
    fake.tasks.push(
      { id: 'q1', chat_id: 'x', session_ids: ['s2'], question: 'Вопрос по второй', model: 'm', status: 'running', snapshot_id: null, answer: '', error: null, kind: 'chat', note_id: null, citations: [], activity: [] },
      { id: 'q2', chat_id: '', session_ids: ['s1'], question: '', model: 'm', status: 'queued', snapshot_id: null, answer: '', error: null, kind: 'notes', note_id: null, citations: [], activity: [] },
      { id: 'q3', chat_id: 'y', session_ids: ['s1'], question: 'Прерванный', model: 'm', status: 'paused', snapshot_id: null, answer: '', error: null, kind: 'chat', note_id: null, citations: [], activity: [] },
      { id: 'q4', chat_id: 'z', session_ids: ['s1'], question: 'Готовый', model: 'm', status: 'completed', snapshot_id: null, answer: 'x', error: null, kind: 'chat', note_id: null, citations: [], activity: [] },
    );
    const user = userEvent.setup();
    await renderPanel();
    await user.click(screen.getByRole('button', { name: /Queue · 3/ }));
    const queue = screen.getByRole('dialog', { name: 'Codex queue' });
    expect(within(queue).getByText('Running · Chat · Лекция 2')).toBeInTheDocument();
    expect(within(queue).getByText('Recording notes')).toBeInTheDocument();
    expect(within(queue).queryByText('Готовый')).not.toBeInTheDocument();
    await user.click(within(queue).getByRole('button', { name: 'Cancel' }));
    expect(fake.task('q2').status).toBe('cancelled');
    await user.click(within(screen.getByRole('dialog', { name: 'Codex queue' })).getByRole('button', { name: 'Continue' }));
    expect(fake.task('q3').status).toBe('queued');
    expect(window.audiohelper.reportCodexActivity).toHaveBeenCalled();
  });
});

describe('Codex note edits', () => {
  const setup = () => {
    fake.chats.push({ id: 'c', session_id: 's1', title: 'Правки', scope: 'session', group_id: null, revoked: false, unread: false, updated_at: 't' });
    fake.messages.c = [];
    fake.selected.s1 = 'c';
    fake.notes.push({ id: 'n1', revision: 3, content: 'Бюджет 10.', title: 'Итоги', created_at: 't', model: 'm', citations: [] });
    fake.previews.push({ id: 'p1', chat_id: 'c', session_id: 's1', note_id: 'n1', expected_revision: 3,
      original: 'Бюджет 10.', replacement: 'Бюджет 12.', status: 'pending' });
    useStore.setState({ detail: { segments: [], messages: [], notes: null, notes_list: [{ ...fake.notes[0]! }] } });
  };

  it('writes nothing until compared and confirmed, then updates the note in place', async () => {
    setup();
    const user = userEvent.setup();
    await renderPanel();
    const card = await screen.findByTestId('codex-preview');
    expect(card).toHaveTextContent('“Итоги” · Лекция 1');
    await user.click(within(card).getByRole('button', { name: 'Compare and apply' }));
    const diff = screen.getByRole('dialog', { name: 'Note edit' });
    expect(diff).toHaveTextContent('Бюджет 10.');
    expect(diff).toHaveTextContent('Бюджет 12.');
    expect(fake.calls.some((c) => c.path.endsWith('/apply'))).toBe(false);
    await user.click(within(diff).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(useStore.getState().detail?.notes_list?.[0]?.content).toBe('Бюджет 12.'));
    expect(fake.calls.find((c) => c.path.endsWith('/apply'))!.body).toEqual({ confirmed: true });
    expect(screen.queryByTestId('codex-preview')).not.toBeInTheDocument();
  });

  it('shows a revision conflict and never forces the write', async () => {
    setup();
    fake.failApply = { status: 409, detail: 'Note revision changed' };
    const user = userEvent.setup();
    await renderPanel();
    const card = await screen.findByTestId('codex-preview');
    await user.click(within(card).getByRole('button', { name: 'Compare and apply' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Note edit' })).getByRole('button', { name: 'Apply' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('The note changed');
    expect(within(card).getByRole('button', { name: 'Compare and apply' })).toBeDisabled();
    expect(fake.calls.filter((c) => c.path.endsWith('/apply'))).toHaveLength(1);
    expect(useStore.getState().detail?.notes_list?.[0]?.content).toBe('Бюджет 10.');
  });

  it('discards a preview on request', async () => {
    setup();
    const user = userEvent.setup();
    await renderPanel();
    await user.click(within(await screen.findByTestId('codex-preview')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('codex-preview')).not.toBeInTheDocument());
    expect(fake.previews).toHaveLength(0);
  });
});

describe('streaming persistence of polling', () => {
  it('polls on its own while a task is active and stops once none is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fake.chats.push({ id: 'c', session_id: 's1', title: 'X', scope: 'session', group_id: null, revoked: false, unread: false, updated_at: 't' });
      fake.messages.c = [];
      fake.selected.s1 = 'c';
      fake.tasks.push({ id: 't', chat_id: 'c', session_ids: ['s1'], question: 'Q', model: 'm', status: 'running', snapshot_id: null, answer: 'A', error: null, kind: 'chat', note_id: null, citations: [], activity: [] });
      await renderPanel();
      fake.update('t', { answer: 'AB' });
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(await screen.findByText('AB')).toBeInTheDocument();
      fake.update('t', { status: 'completed' });
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      const reads = fake.calls.filter((c) => c.path === '/codex/state').length;
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(fake.calls.filter((c) => c.path === '/codex/state').length).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });
});
