import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantPanel } from './AssistantPanel';
import { useStore } from '../../state/store';
import type { Citation, Message } from '../../api/types';

const seedDetail = (messages: Message[]) => {
  useStore.setState({
    activeSessionId: 's1',
    detail: { segments: [], messages, notes: null },
    chatScope: 'auto',
    windowMinutes: 5,
    asking: false,
    askError: null,
  });
};

beforeEach(() => {
  seedDetail([]);
});

describe('AssistantPanel', () => {
  it('shows the restored illustration and tagline when there are no messages', () => {
    render(<AssistantPanel onCite={vi.fn()} />);
    expect(screen.getByTestId('assistant-figure')).toBeInTheDocument();
    expect(screen.getByText('Больше чем слушать')).toBeInTheDocument();
  });

  it('changes the question scope in the store', async () => {
    const user = userEvent.setup();
    render(<AssistantPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Auto' }));
    await user.click(screen.getByRole('tab', { name: 'Search' }));
    expect(useStore.getState().chatScope).toBe('search');
  });

  it('hides the window presets for non-window scopes', async () => {
    const user = userEvent.setup();
    render(<AssistantPanel onCite={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '5m' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Auto' }));
    expect(screen.getByRole('button', { name: '5m' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.queryByRole('button', { name: '5m' })).not.toBeInTheDocument();
  });

  it('invokes onCite with the citation when a citation chip is clicked', async () => {
    const citation: Citation = { segment_id: 'seg-42', start_ms: 65000, end_ms: 70000, text: 'the key point' };
    seedDetail([
      { id: 'm1', role: 'user', content: 'what did I miss', created_at: 't' },
      { id: 'm2', role: 'assistant', content: 'You missed the intro.', created_at: 't', citations: [citation] },
    ]);
    const onCite = vi.fn();
    const user = userEvent.setup();
    render(<AssistantPanel onCite={onCite} />);
    // The chip renders the citation timecode (01:05).
    await user.click(screen.getByRole('button', { name: /01:05/ }));
    expect(onCite).toHaveBeenCalledWith(citation);
  });

  it('disables the composer when there is no active session', () => {
    useStore.setState({ activeSessionId: null });
    render(<AssistantPanel onCite={vi.fn()} />);
    expect(screen.getByPlaceholderText('Start a session to ask questions')).toBeDisabled();
  });
});
