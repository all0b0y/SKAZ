import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbMessage, KbToolPart, KbWebSearchPart } from '../../api/kb/types.gen';
import { ThoughtLine, callStates } from './ThoughtLine';

const tool = (call_id: string, status?: KbToolPart['status']): KbToolPart => ({
  type: 'tool', name: 'skaz_search', label: 'Search', call_id, status,
});

describe('Persisted tool outcomes, not an inference from the next answer part', () => {
  it.each<KbMessage['state']>(['streaming', 'done', 'failed', 'cancelled', 'interrupted'])(
    'keeps independent outcomes in a %s answer, with old calls explicitly unknown', (state) => {
      const parts = [tool('ok', 'done'), tool('bad', 'error'), tool('stop', 'stopped'),
        tool('missing', 'unknown'), tool('live', 'running'), tool('legacy'),
        { type: 'text' as const, text: 'The agent went on, not a tool result.' }];
      expect(callStates(parts, state).map((c) => c.state)).toEqual([
        'done', 'error', 'stopped', 'unknown', state === 'streaming' ? 'run' : 'unknown', 'unknown',
      ]);
    },
  );
});

const START = Date.parse('2026-10-31T10:00:00Z');
const message = (part: KbToolPart, state: KbMessage['state']): KbMessage => ({
  id: 'answer', seq: 2, role: 'assistant', state, parts: [part], created_at: new Date(START).toISOString(),
  engine: 'codex', model: null, failure: null, input: null, saved_page_id: null,
});
afterEach(() => vi.useRealTimers());

describe('Call times are measured by the backend and survive reopening', () => {
  it('a call already running when opened counts from its actual start, not when it appeared on screen', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START + 3_000);
    const running = { ...tool('c', 'running'), started_at: new Date(START + 1_000).toISOString() };
    const { container } = render(<ThoughtLine message={message(running, 'streaming')} head={null} />);
    expect(container.querySelector('.kb-call__time')).toHaveTextContent('2.0 s');
    act(() => { vi.advanceTimersByTime(500); });
    expect(container.querySelector('.kb-call__time')).toHaveTextContent('2.5 s');
  });

  it('a completed call reopened later shows only its stored duration, never a new stopwatch', async () => {
    const complete = { ...tool('c', 'done'), started_at: new Date(START).toISOString(), duration_ms: 2_450 };
    const { container } = render(<ThoughtLine message={message(complete, 'done')} head={null} />);
    await userEvent.setup().click(screen.getByRole('button'));
    expect(container.querySelector('.kb-call__time')).toHaveTextContent('2.4 s');
  });
});

it('a legacy call has visible unknown words, without a success check or made-up time', async () => {
  const legacy: KbToolPart = { type: 'tool', name: 'skaz_search', label: 'Search' };
  const { container } = render(<ThoughtLine message={message(legacy, 'done')} head={null} />);
  await userEvent.setup().click(screen.getByRole('button'));
  expect(screen.getByRole('listitem')).toHaveTextContent('result unknown');
  expect(screen.queryByLabelText('Done')).toBeNull();
  expect(container.querySelector('.kb-call__time')).toBeNull();
});

describe('Factual summary counts every call, including web search', () => {
  it('counts calls, not unique names or sources; only confirmed errors are failed', () => {
    const m = { ...message(tool('ok', 'done'), 'done'), parts: [tool('ok', 'done'), tool('legacy'),
      { ...tool('web', 'error'), name: 'mcp__skaz__skaz_web_search' }, tool('another', 'unknown')] };
    render(<ThoughtLine message={m} head={null} />);
    expect(screen.getByRole('button', { name: '4 tool calls · 1 failed' })).toBeInTheDocument();
  });

  it('a web-only summary is singular, visible and has no empty expand affordance', () => {
    render(<ThoughtLine message={message({ ...tool('web', 'done'), name: 'skaz_web_search' }, 'done')} head={null} />);
    expect(screen.getByText('1 tool call')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('no failure suffix for an unknown result', () => {
    render(<ThoughtLine message={message(tool('legacy'), 'done')} head={null} />);
    expect(screen.getByRole('button', { name: '1 tool call' })).toBeInTheDocument();
  });
});

const nativeCard = (extra: Partial<KbWebSearchPart> = {}): KbWebSearchPart => ({
  type: 'web_search', id: 'web-native', engine: 'claude_code', query: 'entropy',
  status: 'allowed', auto: false, reason: null, links: [], allowed_domains: [], blocked_domains: [],
  call_id: 'native-call', ...extra,
});

it('native web activity is counted once, with no duplicate chip or empty expand', () => {
  const native = { ...tool('native-call', 'done'), name: 'WebSearch' };
  const m = { ...message(native, 'done'), parts: [native, nativeCard({ execution: 'done' })] };
  render(<ThoughtLine message={m} head={null} />);
  expect(screen.getByText('1 tool call', { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
  expect(callStates(m.parts, 'done')).toEqual([]);
});

it('a durable native card error counts even if the final tool event was lost, without double counting', () => {
  const native = { ...tool('native-call', 'unknown'), name: 'WebSearch' };
  const card = nativeCard({ execution: 'error' });
  const m = { ...message(native, 'done'), parts: [native, card, card] };
  const { rerender } = render(<ThoughtLine message={m} head={null} />);
  expect(screen.getByText('1 tool call · 1 failed', { exact: true })).toBeInTheDocument();
  rerender(<ThoughtLine message={{ ...m, parts: [{ ...native, status: 'error' }, card] }} head={null} />);
  expect(screen.getByText('1 tool call · 1 failed', { exact: true })).toBeInTheDocument();
});

it('legacy native cards count attempted calls without inventing success or failure', () => {
  const m = { ...message(tool('unused'), 'done'), parts: [nativeCard({ call_id: null })] };
  render(<ThoughtLine message={m} head={null} />);
  expect(screen.getByText('1 tool call', { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});
