import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from './SessionList';
import { useStore } from '../../state/store';
import type { Session } from '../../api/types';
import type { JsonResponse } from '../../api/bridge';

const session = (id: string, title: string, status: Session['status'] = 'stopped'): Session => ({
  id,
  title,
  created_at: '2026-01-01T00:00:00Z',
  status,
  duration_ms: 1_000,
  mode: 'legacy',
});

const seed = (sessions: Session[]) => {
  useStore.setState({
    sessions,
    activeSessionId: sessions[0]?.id ?? null,
    recorderState: 'idle',
    newSession: vi.fn(async () => undefined),
    selectSession: vi.fn(async () => undefined),
    removeSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    backend: { phase: 'ready' },
  });
};

const onOpenSettings = () => vi.fn();
const onOpenSearch = () => vi.fn();

beforeEach(() => {
  localStorage.clear();
  window.audiohelper = { ...window.audiohelper,
    request: async <T,>(): Promise<JsonResponse<T>> => ({ ok: true, status: 200,
      data: { enabled: false, revision: 0, pending: null, data: { version: 1, groups: [], membership: {} } } as T }),
  };
  seed([]);
});

it('creates and restores an empty named group with an optional tag', async () => {
  seed([session('s1', 'Lecture')]);
  const user = userEvent.setup();
  const view = render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
  await user.click(screen.getByRole('button', { name: 'Create group' }));
  await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'University');
  await user.type(screen.getByRole('textbox', { name: 'Tag (optional)' }), '#study');
  await user.click(screen.getByRole('button', { name: 'Create' }));
  expect(screen.getByRole('tab', { name: /University #study 0/ })).toBeInTheDocument();
  view.unmount();
  render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
  expect(screen.getByRole('tab', { name: /University #study 0/ })).toBeInTheDocument();
});

describe('SessionList group chips', () => {
  it('shows All and a create-group control when no session carries a tag', () => {
    seed([session('s1', 'Plain session')]);
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    expect(screen.getByRole('tab', { name: /All/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Create group' })).toBeInTheDocument();
  });

  it('has no Ungrouped chip when every session carries a tag', () => {
    seed([session('s1', 'A #tag')]);
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    expect(screen.queryByRole('tab', { name: /Ungrouped/ })).not.toBeInTheDocument();
  });

  it('imports first legacy tags as single membership with accurate counts', () => {
    seed([
      session('s1', 'Матан #универ'),
      session('s2', 'Standup #work'),
      session('s3', 'Recap #универ #work'),
      session('s4', 'No tags here'),
    ]);
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    expect(screen.getByRole('tab', { name: /^All 4/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /универ 2/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /#work 1/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('filters the session list to the selected group and strips tags from displayed names', async () => {
    seed([
      session('s1', 'Матан #универ'),
      session('s2', 'Standup #work'),
      session('s3', 'No tags'),
    ]);
    const user = userEvent.setup();
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);

    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Матан')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /универ/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Матан')).toBeInTheDocument();
    expect(within(list).queryByText('Standup')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /All/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('No tags')).toBeInTheDocument();
  });

  it('shows a legacy multi-tag session only in its first group and All', async () => {
    seed([session('s1', 'Both #uni #work')]);
    const user = userEvent.setup();
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    const list = screen.getByRole('list');

    await user.click(screen.getByRole('tab', { name: /uni/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);

    expect(screen.queryByRole('tab', { name: /work/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /All/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('SessionList collapse', () => {
  it('collapses and expands via the toggle button and hides the session list while collapsed', async () => {
    seed([session('s1', 'A session')]);
    const user = userEvent.setup();
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    expect(screen.getByRole('list')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Collapse sessions panel/ }));
    expect(screen.queryByRole('list')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Expand sessions panel/ }));
    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('collapses via Cmd+/ ', async () => {
    seed([session('s1', 'A session')]);
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    expect(screen.getByRole('list')).toBeInTheDocument();
    const event = new KeyboardEvent('keydown', { key: '/', metaKey: true });
    act(() => window.dispatchEvent(event));
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('Session navigation actions', () => {
  it('keeps the actions menu open and usable in development StrictMode', async () => {
    seed([session('s1', 'Lecture')]);
    const user = userEvent.setup();
    render(<StrictMode><SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} /></StrictMode>);
    await user.click(screen.getByRole('button', { name: 'Actions for Lecture' }));
    expect(screen.getByRole('menu', { name: 'Session actions' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(screen.getByRole('textbox', { name: 'Session name' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Actions for Lecture' })).toHaveFocus();
  });

  const show = () => render(<StrictMode><SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} /></StrictMode>);
  const createGroup = async (user: ReturnType<typeof userEvent.setup>, name: string, tag = '') => {
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), name);
    if (tag) await user.type(screen.getByRole('textbox', { name: 'Tag (optional)' }), tag);
    await user.click(screen.getByRole('button', { name: 'Create' }));
  };

  it('validates empty/duplicate names and single tags, supports Enter/Escape and restores focus', async () => {
    const user = userEvent.setup(); show();
    await createGroup(user, 'Study');
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    expect(screen.getByRole('textbox', { name: 'Group name' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), ' study {Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
    await user.clear(screen.getByRole('textbox', { name: 'Group name' }));
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Work');
    await user.type(screen.getByRole('textbox', { name: 'Tag (optional)' }), '#one #two{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('one tag');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create group' })).toHaveFocus();
  });

  it('moves via menu without selecting the session and persists exactly one membership', async () => {
    seed([session('s1', 'Lecture')]); const user = userEvent.setup(); const view = show();
    await createGroup(user, 'Study', '#uni'); await createGroup(user, 'Work');
    await user.click(screen.getByRole('button', { name: 'Actions for Lecture' }));
    expect(useStore.getState().selectSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('menuitem', { name: 'Move to group…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Study/ }));
    expect(screen.getByRole('tab', { name: /Study #uni 1/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for Lecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to group…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Work' }));
    expect(screen.getByRole('tab', { name: /Study #uni 0/ })).toBeInTheDocument();
    view.unmount(); show();
    expect(screen.getByRole('tab', { name: /Work 1/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /All 1/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for Lecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove from group' }));
    expect(screen.getByRole('tab', { name: /Work 0/ })).toBeInTheDocument();
  });

  it('edits a group without losing membership and deletes it without deleting sessions or reimporting tags', async () => {
    seed([session('s1', 'Lecture #uni')]); const user = userEvent.setup(); const view = show();
    fireEvent.contextMenu(screen.getByRole('tab', { name: /uni/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit name and tag' }));
    await user.clear(screen.getByRole('textbox', { name: 'Group name' }));
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'University');
    await user.clear(screen.getByRole('textbox', { name: 'Tag (optional)' }));
    await user.type(screen.getByRole('textbox', { name: 'Tag (optional)' }), '#study{Enter}');
    const group = screen.getByRole('tab', { name: /University #study 1/ });
    await user.click(group); fireEvent.contextMenu(group);
    await user.click(screen.getByRole('menuitem', { name: 'Delete group…' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('sessions will remain in All');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useStore.getState().removeSession).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /All 1/ })).toHaveAttribute('aria-selected', 'true');
    view.unmount(); show();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByText('Lecture')).toBeInTheDocument();
  });

  it('renames with failure feedback and requires confirmation to delete a session', async () => {
    seed([session('s1', 'Lecture')]); const user = userEvent.setup(); show();
    vi.mocked(useStore.getState().renameSession).mockRejectedValueOnce(new Error('Rename failed'));
    await user.click(screen.getByRole('button', { name: 'Actions for Lecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.clear(screen.getByRole('textbox', { name: 'Session name' }));
    await user.type(screen.getByRole('textbox', { name: 'Session name' }), 'Physics{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Rename failed');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(useStore.getState().renameSession).toHaveBeenLastCalledWith('s1', 'Physics');
    await user.click(screen.getByRole('button', { name: 'Actions for Lecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete session…' }));
    expect(useStore.getState().removeSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useStore.getState().removeSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Actions for Lecture' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete session…' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useStore.getState().removeSession).toHaveBeenCalledWith('s1');
  });

  it('prevents deleting the active recording and keeps menu navigation keyboard accessible', async () => {
    seed([session('s1', 'Live', 'recording')]); useStore.setState({ recorderState: 'recording' });
    const user = userEvent.setup(); show();
    await user.click(screen.getByRole('button', { name: 'Actions for Live' }));
    expect(screen.getByRole('menuitem', { name: 'Delete session…' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Move to group…' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Actions for Live' })).toHaveFocus();
  });

  it('drags a session to a group and back to All without opening it', async () => {
    seed([session('s1', 'Lecture')]); const user = userEvent.setup(); show();
    await createGroup(user, 'Study');
    const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    const row = screen.getByRole('listitem'); const group = screen.getByRole('tab', { name: /Study/ });
    fireEvent.dragStart(row, { dataTransfer: transfer });
    fireEvent.dragOver(group, { dataTransfer: transfer });
    expect(group).toHaveClass('chip--drop');
    fireEvent.drop(group, { dataTransfer: transfer });
    expect(screen.getByRole('tab', { name: /Study 1/ })).toBeInTheDocument();
    fireEvent.dragStart(row, { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole('tab', { name: /All/ }), { dataTransfer: transfer });
    expect(screen.getByRole('tab', { name: /Study 0/ })).toBeInTheDocument();
    expect(useStore.getState().selectSession).not.toHaveBeenCalled();
  });

  it('previews group reordering, cancels on dragend, persists on drop and keeps All first', async () => {
    const user = userEvent.setup(); const view = show();
    await createGroup(user, 'First'); await createGroup(user, 'Second');
    const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    const first = screen.getByRole('tab', { name: /First/ }); const second = screen.getByRole('tab', { name: /Second/ });
    fireEvent.dragStart(second, { dataTransfer: transfer });
    fireEvent.dragOver(first, { dataTransfer: transfer });
    expect(screen.getAllByRole('tab')[1]).toHaveTextContent('Second');
    fireEvent.dragEnd(second);
    expect(screen.getAllByRole('tab')[1]).toHaveTextContent('First');
    fireEvent.dragStart(second, { dataTransfer: transfer });
    fireEvent.dragOver(first, { dataTransfer: transfer });
    fireEvent.drop(first, { dataTransfer: transfer });
    view.unmount(); show();
    expect(screen.getAllByRole('tab')[0]).toHaveTextContent('All');
    expect(screen.getAllByRole('tab')[1]).toHaveTextContent('Second');
  });

  it('traps modal focus, supports group keyboard context menu and reorder', async () => {
    const user = userEvent.setup(); show();
    await createGroup(user, 'First'); await createGroup(user, 'Second');
    const second = screen.getByRole('tab', { name: /Second/ });
    second.focus(); await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(screen.getAllByRole('tab')[1]).toHaveTextContent('Second');
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.click(screen.getByRole('menuitem', { name: 'Edit name and tag' }));
    expect(screen.getByRole('textbox', { name: 'Group name' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Group name' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(second).toHaveFocus();
  });

  it('shows a storage write failure without adding an unsaved group', async () => {
    const user = userEvent.setup(); show();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    try {
      await createGroup(user, 'Study');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save groups');
      expect(screen.queryByRole('tab', { name: /Study/ })).not.toBeInTheDocument();
    } finally { write.mockRestore(); }
  });

  it('does not overwrite unreadable preferences and reports failed persistence', async () => {
    localStorage.setItem('audiohelper.session-groups.v1', 'broken');
    const user = userEvent.setup(); show();
    expect(screen.getByRole('alert')).toHaveTextContent('have not been overwritten');
    await createGroup(user, 'Study');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(localStorage.getItem('audiohelper.session-groups.v1')).toBe('broken');
    expect(screen.queryByRole('tab', { name: /Study/ })).not.toBeInTheDocument();
  });
});

describe('SessionList footer', () => {
  it('exposes accessible search and settings buttons', async () => {
    seed([session('s1', 'A session')]);
    const openSearch = vi.fn();
    const openSettings = vi.fn();
    const user = userEvent.setup();
    render(<SessionList onOpenSettings={openSettings} onOpenSearch={openSearch} />);
    await user.click(screen.getByRole('button', { name: 'Search materials' }));
    expect(openSearch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
