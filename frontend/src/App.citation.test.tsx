import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from './api/types';
import { CITATION_FOCUS_MS } from './hooks/useCitationFocus';
import { openSettings } from './lib/openSettings';

// App wiring only: every pane is a stand-in that shows what App hands it, so
// the test pins the citation focus and settings routing, not pane internals.
vi.mock('./components/transcript/TranscriptView', () => ({
  TranscriptView: ({ focusSegmentId }: { focusSegmentId: string | null }) =>
    <p data-testid="transcript-focus">{focusSegmentId ?? 'none'}</p>,
}));
const citation: Citation = { session_id: 's1', segment_id: 'seg-7', start_ms: 0, end_ms: 1000, text: 'q' };
vi.mock('./components/assistant/AssistantPanel', () => ({
  AssistantPanel: ({ onCite }: { onCite: (c: Citation) => void }) =>
    <button type="button" onClick={() => onCite(citation)}>cite</button>,
}));
vi.mock('./components/notes/NotesPanel', () => ({ NotesPanel: () => <p>notes pane</p> }));
vi.mock('./components/sessions/SessionList', () => ({ SessionList: () => null }));
vi.mock('./components/sessions/BackendStatusDot', () => ({ BackendStatusDot: () => null }));
vi.mock('./components/recorder/RecorderBar', () => ({ RecorderBar: () => null }));
vi.mock('./components/web/WebSearchApproval', () => ({ WebSearchApproval: () => null }));
vi.mock('./components/search/SearchPalette', () => ({ SearchPalette: () => null }));
vi.mock('./components/onboarding/LanguageOnboarding', () => ({ LanguageOnboarding: () => null }));
vi.mock('./components/settings/SettingsPanel', () => ({
  SettingsPanel: ({ initialSection }: { initialSection: string }) => <p data-testid="settings">{initialSection}</p>,
}));

let App: typeof import('./App')['default'];

beforeEach(async () => {
  vi.useFakeTimers();
  const { useStore } = await import('./state/store');
  useStore.setState({
    init: vi.fn(async () => undefined), ready: true, activeSessionId: 's1', imports: {},
    sessions: [{ id: 's1', title: 'S1', created_at: '' } as never, { id: 's2', title: 'S2', created_at: '' } as never],
    recorderState: 'idle', settings: null,
    selectSession: vi.fn(async (id: string) => { useStore.setState({ activeSessionId: id }); }),
  });
  App = (await import('./App')).default;
});
afterEach(() => { vi.useRealTimers(); });

const focus = () => screen.getByTestId('transcript-focus').textContent;
const cite = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'cite' })); });
  await act(async () => { vi.advanceTimersByTime(0); });
};

describe('App — a citation jump does not outlive its moment', () => {
  it('focuses the cited fragment, then releases it after the highlight', async () => {
    render(<App />);
    await cite();
    expect(focus()).toBe('seg-7');
    await act(async () => { vi.advanceTimersByTime(CITATION_FOCUS_MS); });
    expect(focus()).toBe('none');
  });

  it('does not jump again when the reader returns from Notes', async () => {
    render(<App />);
    await cite();
    expect(focus()).toBe('seg-7');
    fireEvent.click(screen.getByRole('tab', { name: /Notes/ }));
    expect(screen.getByText('notes pane')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Transcript/ }));
    expect(focus()).toBe('none');
  });

  it('does not carry the jump into another session', async () => {
    const { useStore } = await import('./state/store');
    render(<App />);
    await cite();
    act(() => useStore.setState({ activeSessionId: 's2' }));
    expect(focus()).toBe('none');
    act(() => useStore.setState({ activeSessionId: 's1' }));
    expect(focus()).toBe('none');
  });

  it('jumps again on a repeat click on the same citation', async () => {
    render(<App />);
    await cite();
    await act(async () => { vi.advanceTimersByTime(CITATION_FOCUS_MS); });
    expect(focus()).toBe('none');
    await cite();
    expect(focus()).toBe('seg-7');
  });
});

describe('App — notices open Settings on the section that fixes them', () => {
  it('opens the requested section', () => {
    render(<App />);
    act(() => openSettings('api-keys'));
    expect(screen.getByTestId('settings')).toHaveTextContent('api-keys');
  });
});
