import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from './SessionList';
import { useStore } from '../../state/store';
import type { Session } from '../../api/types';
import type { JsonResponse } from '../../api/bridge';

const session = (id: string, title: string, status: Session['status'] = 'stopped'): Session => ({
  id, title, created_at: '2026-01-01T00:00:00Z', status, duration_ms: 1_000, mode: 'legacy',
});

const seed = (sessions: Session[]) => {
  useStore.setState({
    sessions,
    activeSessionId: sessions[0]?.id ?? null,
    recorderState: 'idle',
    newSession: vi.fn(async () => undefined),
    selectSession: vi.fn(async () => undefined),
    removeSession: vi.fn(async () => undefined),
    removeSessions: vi.fn(async (ids: string[]) => ({ deleted: ids, failed: [] })),
    renameSession: vi.fn(async () => undefined),
    backend: { phase: 'ready' },
  });
};

const show = () => render(<SessionList onOpenSettings={vi.fn()} onOpenSearch={vi.fn()} />);
const row = (title: string) => screen.getByRole('button', { name: new RegExp(`^${title}`) });
const checked = () => screen.getAllByRole('checkbox', { checked: true }).map((c) => c.getAttribute('aria-label'));

beforeEach(() => {
  localStorage.clear();
  window.skaz = { ...window.skaz,
    request: async <T,>(): Promise<JsonResponse<T>> => ({ ok: true, status: 200,
      data: { enabled: false, revision: 0, pending: null, data: { version: 1, groups: [], membership: {} } } as T }),
  };
  seed(['a', 'b', 'c', 'd'].map((id) => session(id, `Talk ${id.toUpperCase()}`)));
});

describe('Session multi-select', () => {
  it('shows no checkboxes or action bar until something is selected', () => {
    show();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Selected sessions' })).not.toBeInTheDocument();
  });

  it('⌘-click toggles selection without opening, and Escape clears it', async () => {
    const user = userEvent.setup(); show();
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.click(row('Talk C')); await user.keyboard('{/Meta}');
    expect(useStore.getState().selectSession).not.toHaveBeenCalled();
    expect(checked()).toEqual(['Select Talk A', 'Select Talk C']);
    expect(screen.getByRole('toolbar', { name: 'Selected sessions' })).toHaveTextContent('2 selected');
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.keyboard('{/Meta}');
    expect(checked()).toEqual(['Select Talk C']);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('Shift-click selects a range and ⌘A selects every visible session', async () => {
    const user = userEvent.setup(); show();
    await user.keyboard('{Meta>}'); await user.click(row('Talk B')); await user.keyboard('{/Meta}');
    await user.keyboard('{Shift>}'); await user.click(row('Talk D')); await user.keyboard('{/Shift}');
    expect(checked()).toEqual(['Select Talk B', 'Select Talk C', 'Select Talk D']);
    await user.keyboard('{Meta>}a{/Meta}');
    expect(checked()).toHaveLength(4);
  });

  it('a plain click opens the session and ends the selection', async () => {
    const user = userEvent.setup(); show();
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.keyboard('{/Meta}');
    await user.click(row('Talk B'));
    expect(useStore.getState().selectSession).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('Select… in the context menu starts a selection with that session', async () => {
    const user = userEvent.setup(); show();
    await user.click(screen.getByRole('button', { name: 'Actions for Talk B' }));
    await user.click(screen.getByRole('menuitem', { name: 'Select…' }));
    expect(checked()).toEqual(['Select Talk B']);
    await user.click(screen.getByRole('checkbox', { name: 'Select Talk D' }));
    expect(checked()).toEqual(['Select Talk B', 'Select Talk D']);
  });

  it('deletes the selection after one confirmation listing the titles', async () => {
    const user = userEvent.setup(); show();
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.click(row('Talk B')); await user.keyboard('{/Meta}');
    await user.click(within(screen.getByRole('toolbar', { name: 'Selected sessions' })).getByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete 2 sessions?' });
    expect(dialog).toHaveTextContent('Talk A');
    expect(dialog).toHaveTextContent('Talk B');
    expect(dialog).toHaveTextContent('cannot be undone');
    expect(useStore.getState().removeSessions).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(useStore.getState().removeSessions).toHaveBeenCalledWith(['a', 'b']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the recording session out of a bulk delete and says so', async () => {
    useStore.setState({ activeSessionId: 'a', recorderState: 'paused' });
    const user = userEvent.setup(); show();
    await user.keyboard('{Meta>}'); await user.click(row('Talk B')); await user.keyboard('{/Meta}');
    expect(useStore.getState().selectSession).not.toHaveBeenCalled();
    await user.keyboard('{Meta>}a{/Meta}');
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete 3 sessions?' });
    expect(dialog).toHaveTextContent('“Talk A” is recording and will be kept.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(useStore.getState().removeSessions).toHaveBeenCalledWith(['b', 'c', 'd']);
  });

  it('names at most five titles', async () => {
    seed(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => session(id, `Talk ${id.toUpperCase()}`)));
    const user = userEvent.setup(); show();
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.keyboard('{/Meta}');
    await user.keyboard('{Meta>}a{/Meta}');
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete 7 sessions?' });
    expect(dialog).toHaveTextContent('Talk E');
    expect(dialog).not.toHaveTextContent('Talk F');
    expect(dialog).toHaveTextContent('…and 2 more');
  });

  it('keeps failed sessions selected and reports why', async () => {
    vi.mocked(useStore.getState().removeSessions).mockResolvedValueOnce({
      deleted: ['a'], failed: [{ id: 'b', reason: 'Markdown files need attention.' }] });
    const user = userEvent.setup(); show();
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.click(row('Talk B')); await user.keyboard('{/Meta}');
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alert')).toHaveTextContent('1 of 2 not deleted — Markdown files need attention.');
    expect(checked()).toEqual(['Select Talk B']);
  });

  it('context menu on a selected session acts on the whole selection', async () => {
    const user = userEvent.setup(); show();
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.click(row('Talk C')); await user.keyboard('{/Meta}');
    fireEvent.contextMenu(row('Talk C'));
    expect(screen.getByRole('menuitem', { name: 'Move 2 sessions…' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Delete 2 sessions…' }));
    expect(screen.getByRole('dialog', { name: 'Delete 2 sessions?' })).toBeInTheDocument();
  });

  it('moves the selection to a group from the bar, including a new group', async () => {
    const user = userEvent.setup(); show();
    await user.click(screen.getByRole('button', { name: 'New group' }));
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Study{Enter}');
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.click(row('Talk B')); await user.keyboard('{/Meta}');
    await user.click(screen.getByRole('button', { name: 'Move…' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Move 2 sessions to group' })).getByRole('button', { name: 'Study' }));
    expect(screen.getByRole('tab', { name: /Study 2/ })).toBeInTheDocument();

    await user.keyboard('{Meta>}'); await user.click(row('Talk C')); await user.click(row('Talk D')); await user.keyboard('{/Meta}');
    await user.click(screen.getByRole('button', { name: 'Move…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'New group…' }));
    expect(screen.getByRole('dialog', { name: 'New group for these sessions' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Work');
    await user.click(screen.getByRole('button', { name: 'Create and move' }));
    expect(screen.getByRole('tab', { name: /Work 2/ })).toBeInTheDocument();
  });

  it('dragging a selected row moves the whole selection', async () => {
    const user = userEvent.setup(); show();
    await user.click(screen.getByRole('button', { name: 'New group' }));
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Study{Enter}');
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.click(row('Talk D')); await user.keyboard('{/Meta}');
    const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    const group = screen.getByRole('tab', { name: /Study/ });
    fireEvent.dragStart(row('Talk D').closest('li')!, { dataTransfer: transfer });
    fireEvent.dragOver(group, { dataTransfer: transfer });
    fireEvent.drop(group, { dataTransfer: transfer });
    expect(screen.getByRole('tab', { name: /Study 2/ })).toBeInTheDocument();
  });

  it('switching the group filter clears the selection', async () => {
    const user = userEvent.setup(); show();
    await user.keyboard('{Meta>}'); await user.click(row('Talk A')); await user.keyboard('{/Meta}');
    await user.click(screen.getByRole('tab', { name: /All/ }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
