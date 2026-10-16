import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchPalette } from './SearchPalette';
import { useStore } from '../../state/store';
import type { Session, Segment } from '../../api/types';

const session = (id: string, title: string): Session => ({
  id, title, created_at: '2026-01-01T00:00:00Z', status: 'stopped', duration_ms: 1_000, mode: 'legacy',
});

const seed = (sessions: Session[], segments: Segment[] = []) => {
  useStore.setState({
    sessions,
    activeSessionId: sessions[0]?.id ?? null,
    detail: { segments, messages: [], notes: null },
    selectSession: vi.fn(async () => undefined),
  });
};

beforeEach(() => {
  seed([]);
});

describe('SearchPalette', () => {
  it('renders nothing when closed', () => {
    render(<SearchPalette open={false} onClose={vi.fn()} onCite={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('finds a session by name and selects it on click', async () => {
    seed([session('s1', 'Physics lecture'), session('s2', 'Grocery run')]);
    const user = userEvent.setup();
    render(<SearchPalette open onClose={vi.fn()} onCite={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Search materials' }), 'physics');
    const option = screen.getByRole('option', { name: /Physics lecture/i });
    await user.click(option);
    expect(useStore.getState().selectSession).toHaveBeenCalledWith('s1');
  });

  it('finds a transcript fragment in the active session and cites it', async () => {
    seed(
      [session('s1', 'Session A')],
      [{ id: 'seg-1', start_ms: 5_000, end_ms: 8_000, text: 'we discussed the quarterly budget' }],
    );
    const user = userEvent.setup();
    const onCite = vi.fn();
    render(<SearchPalette open onClose={vi.fn()} onCite={onCite} />);
    await user.type(screen.getByRole('textbox', { name: 'Search materials' }), 'budget');
    const option = screen.getByRole('option', { name: /quarterly budget/i });
    await user.click(option);
    expect(onCite).toHaveBeenCalledWith({
      segment_id: 'seg-1', start_ms: 5_000, end_ms: 8_000, text: 'we discussed the quarterly budget',
    });
  });

  it('only searches fragments of the loaded session and says so', async () => {
    seed([session('s1', 'Session A')], []);
    const user = userEvent.setup();
    render(<SearchPalette open onClose={vi.fn()} onCite={vi.fn()} />);
    expect(screen.getByText(/Fragments are searched in the open session only/i)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Search materials' }), 'nothing matches this');
    expect(screen.getByText(/No matches in the open session/i)).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    seed([session('s1', 'Session A')]);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SearchPalette open onClose={onClose} onCite={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Search materials' }), '{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked', async () => {
    seed([session('s1', 'Session A')]);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SearchPalette open onClose={onClose} onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Close search' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports arrow-key navigation and Enter to activate the highlighted result', async () => {
    seed([session('s1', 'Alpha session'), session('s2', 'Alpha two')]);
    const user = userEvent.setup();
    render(<SearchPalette open onClose={vi.fn()} onCite={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Search materials' });
    await user.type(input, 'alpha');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(useStore.getState().selectSession).toHaveBeenCalledWith('s2');
  });
});
