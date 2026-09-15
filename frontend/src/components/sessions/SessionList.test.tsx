import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from './SessionList';
import { useStore } from '../../state/store';
import type { Session } from '../../api/types';

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
  seed([]);
});

describe('SessionList group chips', () => {
  it('shows All and Ungrouped but no group chips when no session carries a tag', () => {
    seed([session('s1', 'Plain session')]);
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    expect(screen.getByRole('tab', { name: /All/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Ungrouped/ })).toBeInTheDocument();
  });

  it('has no Ungrouped chip when every session carries a tag', () => {
    seed([session('s1', 'A #tag')]);
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    expect(screen.queryByRole('tab', { name: /Ungrouped/ })).not.toBeInTheDocument();
  });

  it('renders a chip per group with counts and an Ungrouped chip when applicable', () => {
    seed([
      session('s1', 'Матан #универ'),
      session('s2', 'Standup #work'),
      session('s3', 'Recap #универ #work'),
      session('s4', 'No tags here'),
    ]);
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    expect(screen.getByRole('tab', { name: /^All 4/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /универ 2/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /#work 2/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Ungrouped 1/ })).toBeInTheDocument();
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

    await user.click(screen.getByRole('tab', { name: /^Ungrouped/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('No tags')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /All/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  it('shows a session in every group it belongs to', async () => {
    seed([session('s1', 'Both #uni #work')]);
    const user = userEvent.setup();
    render(<SessionList onOpenSettings={onOpenSettings()} onOpenSearch={onOpenSearch()} />);
    const list = screen.getByRole('list');

    await user.click(screen.getByRole('tab', { name: /uni/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);

    await user.click(screen.getByRole('tab', { name: /^#work/ }));
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
