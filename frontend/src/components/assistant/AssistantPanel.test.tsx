import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render as renderUi, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { AssistantPanel } from './AssistantPanel';
import { useStore } from '../../state/store';
import { useCodex } from '../../state/codex';
import type { BridgeApi } from '../../api/bridge';
import type { Citation, Message } from '../../api/types';

// The API engine: a backend that does not serve the Codex boundary (404)
// leaves the settings-selected provider answering in the shared shell.
const initialCodex = useCodex.getState();
const originalBridge = window.skaz;
const render = async (ui: ReactElement) => {
  const utils = renderUi(ui);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Assistant' })).toHaveAttribute('data-engine', 'api'));
  return utils;
};

const seedDetail = (messages: Message[]) => {
  useStore.setState({
    ready: true,
    activeSessionId: 's1',
    detail: { segments: [], messages, notes: null },
    chatScope: 'session',
    asking: false,
    askError: null,
  });
};

beforeEach(() => {
  useCodex.setState(initialCodex, true);
  Object.defineProperty(window, 'skaz', { configurable: true, writable: true,
    value: { ...originalBridge, request: vi.fn(async () => ({ ok: false, status: 404, detail: 'Not Found' })) } as BridgeApi });
  seedDetail([]);
});

afterEach(() => {
  Object.defineProperty(window, 'skaz', { configurable: true, writable: true, value: originalBridge });
});

describe('AssistantPanel', () => {
  it('shows the restored illustration and tagline when there are no messages', async () => {
    await render(<AssistantPanel onCite={vi.fn()} />);
    expect(screen.getByTestId('assistant-figure')).toBeInTheDocument();
    expect(screen.getByText('More than listening')).toBeInTheDocument();
  });

  it('offers only Session / Group / All search scopes with a selected state', async () => {
    const user = userEvent.setup();
    await render(<AssistantPanel onCite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Search · Session' }));
    expect(screen.getByRole('button', { name: 'Session' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Group' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: '5m' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Group' }));
    expect(useStore.getState().chatScope).toBe('group');
    await user.click(screen.getByRole('button', { name: 'Search · Group' }));
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(useStore.getState().chatScope).toBe('all');
  });

  it('keeps an answer saved without label records readable: labels removed, sources listed below', async () => {
    const citation: Citation = { segment_id: 'seg-42', start_ms: 65000, end_ms: 70000, text: 'the key point' };
    seedDetail([
      { id: 'm1', role: 'user', content: 'what did I miss', created_at: 't' },
      { id: 'm2', role: 'assistant', content: 'You missed the intro [P1].', created_at: 't', citations: [citation] },
    ]);
    const onCite = vi.fn();
    const user = userEvent.setup();
    await render(<AssistantPanel onCite={onCite} />);
    expect(screen.getByText('You missed the intro.')).toBeInTheDocument();
    expect(screen.queryByText(/\[P1\]/)).not.toBeInTheDocument();
    const sources = screen.getByLabelText('Answer sources');
    await user.click(within(sources).getByRole('button', { name: /01:05/ }));
    expect(onCite).toHaveBeenCalledWith(citation);
  });

  it('renders Markdown and puts numbered footnotes where the model cited, with no list below', async () => {
    const intro: Citation = { segment_id: 'a', start_ms: 65_000, end_ms: 70_000, text: 'Budget is fixed at ten.', labels: ['P2'] };
    const outro: Citation = { segment_id: 'b', start_ms: 125_000, end_ms: 130_000, text: 'Deadline moved.', labels: ['P3'] };
    const foreign: Citation = { segment_id: 'c', start_ms: 5_000, end_ms: 9_000, text: 'Other talk.', labels: ['P9'],
      session_id: 's2', session_title: 'Lecture 2' };
    seedDetail([{ id: 'm2', role: 'assistant', created_at: 't', citations: [intro, outro, foreign],
      content: '## Итог\n\n- **Бюджет** зафиксирован [P2–P3]\n- Срок перенесён [P3]\n- Другая лекция [P9]\n\n<script>alert(1)</script>' }]);
    const onCite = vi.fn();
    const user = userEvent.setup();
    await render(<AssistantPanel onCite={onCite} />);
    expect(screen.getByRole('heading', { name: 'Итог' })).toBeInTheDocument();
    expect(screen.getByText('Бюджет').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem').filter((li) => li.closest('.md'))).toHaveLength(3);
    expect(document.querySelector('.md script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.queryByText(/\[P/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Answer sources')).not.toBeInTheDocument();
    const refs = screen.getAllByRole('button', { name: /^Source \d/ });
    expect(refs.map((r) => r.textContent)).toEqual(['1', '2', '3']);
    expect(refs[0]).toHaveAttribute('title', '01:05–02:10 — Budget is fixed at ten.');
    expect(refs[2]).toHaveAttribute('title', expect.stringMatching(/^Lecture 2 · 00:05 — Other talk\./));
    await user.click(refs[1]!);
    expect(onCite).toHaveBeenCalledWith(outro);
  });

  it('sends questions without a required embedding budget', async () => {
    const user = userEvent.setup();
    const ask = vi.fn(async () => undefined);
    const originalAsk = useStore.getState().ask;
    useStore.setState({ ask, settings: {
      asr: { provider: 'local-whisper', model: 'small' },
      agent: { provider: 'openrouter', model: 'agent' },
      notes: { provider: 'openrouter', model: 'notes' },
      embedding: { provider: 'openrouter', model: 'qwen/qwen3-embedding-8b' },
      transcript_language: 'auto', output_language: 'ru', cloud_consent: true, contextual_local_enabled: false,
    } });
    try {
      await render(<AssistantPanel onCite={vi.fn()} />);
      expect(screen.queryByLabelText('Embedding budget per question, USD')).not.toBeInTheDocument();
      await user.type(screen.getByPlaceholderText('Ask about your recordings…'), 'Где определение?');
      await user.click(screen.getByRole('button', { name: 'Send question' }));
      expect(ask).toHaveBeenCalledWith('Где определение?');
      expect(screen.queryByLabelText('Embedding budget per question, USD')).not.toBeInTheDocument();
    } finally {
      act(() => useStore.setState({ ask: originalAsk, settings: null }));
    }
  });

  it('disables the composer when there is no active session', async () => {
    useStore.setState({ activeSessionId: null });
    await render(<AssistantPanel onCite={vi.fn()} />);
    expect(screen.getByPlaceholderText('Start a session to ask questions')).toBeDisabled();
  });
});
