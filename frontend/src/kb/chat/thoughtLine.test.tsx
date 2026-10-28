import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbMessage, KbMessagePart } from '../../api/kb/types.gen';
import { CallChip, ThoughtLine, callStates, formatSeconds } from './ThoughtLine';

// Stage 6 B3 (decision 30): ThoughtLine + CallChip. While the agent works: the thinking line with a
// live timer and one chip per tool call; after the answer it folds into «Looked at N things».

const START = Date.parse('2026-10-28T10:00:00Z');
const tool = (name: string, label: string): KbMessagePart => ({ type: 'tool', name, label });
const text = (t: string): KbMessagePart => ({ type: 'text', text: t });
function msg(parts: KbMessagePart[], state: KbMessage['state'] = 'streaming'): KbMessage {
  return {
    id: 'a1', seq: 2, role: 'assistant', created_at: new Date(START).toISOString(), engine: 'claude_code', model: 'opus',
    state, parts, failure: null, saved_page_id: null, input: null,
  };
}
const head = (m: KbMessage) => (m.state === 'streaming' && m.parts.every((p) => p.type === 'tool') ? 'Writing an answer…' : null);

afterEach(() => { vi.useRealTimers(); delete document.documentElement.dataset.motion; });

describe('callStates: what each tool call is doing, from the parts the message already has', () => {
  it('the newest call of a streaming answer runs; a call with anything after it is done', () => {
    const parts = [tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')];
    expect(callStates(parts, 'streaming').map((c) => c.state)).toEqual(['done', 'run']);
    expect(callStates([...parts, text('Entropy is…')], 'streaming').map((c) => c.state)).toEqual(['done', 'done']);
  });

  it('a finished answer finished every call; a stopped one leaves its last call unfinished, not «done»', () => {
    const parts = [tool('skaz_search', 'Searched'), tool('skaz_read_page', 'Read page Entropy')];
    expect(callStates(parts, 'done').map((c) => c.state)).toEqual(['done', 'done']);
    expect(callStates(parts, 'cancelled').map((c) => c.state)).toEqual(['done', 'stopped']);
    expect(callStates(parts, 'interrupted').map((c) => c.state)).toEqual(['done', 'stopped']);
  });

  it('the web search call has its own card and is not a chip (W-3b)', () => {
    expect(callStates([tool('mcp__skaz__skaz_web_search', 'Used skaz_web_search'), tool('skaz_search', 'Searched')], 'done'))
      .toEqual([{ index: 1, name: 'skaz_search', label: 'Searched', state: 'done' }]);
  });
});

describe('formatSeconds: tabular 0.1 s steps, minutes past a minute', () => {
  it('formats', () => {
    expect(formatSeconds(0)).toBe('0.0 s');
    expect(formatSeconds(4.56)).toBe('4.5 s');
    expect(formatSeconds(59.99)).toBe('59.9 s');
    expect(formatSeconds(65)).toBe('1:05');
    expect(formatSeconds(-3)).toBe('0.0 s');
  });
});

describe('ThoughtLine while the agent works', () => {
  it('shows the thinking words with a live timer from when the answer started, and one chip per call', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START + 2_300);
    const m = msg([tool('skaz_search', 'Searched «entropy»')]);
    render(<ThoughtLine message={m} head={head(m)} />);
    const status = screen.getByText('Writing an answer…');
    expect(status).toHaveAttribute('role', 'status');
    expect(screen.getByRole('timer')).toHaveTextContent('2.3 s');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByRole('timer')).toHaveTextContent('3.3 s');
    const calls = screen.getByRole('list', { name: 'Tool calls' });
    const chip = within(calls).getByRole('listitem');
    expect(chip).toHaveTextContent('Searched «entropy»');
    expect(chip).toHaveAttribute('data-state', 'run');
    // No fake percentages: nothing on a running chip claims progress.
    expect(chip.textContent).not.toMatch(/%/);
    expect(screen.queryByRole('button', { name: /Looked at/ })).toBeNull();
  });

  it('a call seen live gets its own timer that stops when it is done; it then shows a check', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START + 1_000);
    const m0 = msg([]);
    const { rerender } = render(<ThoughtLine message={m0} head={head(m0)} />);
    const m1 = msg([tool('skaz_search', 'Searched «entropy»')]);
    rerender(<ThoughtLine message={m1} head={head(m1)} />);
    act(() => { vi.advanceTimersByTime(1_200); });
    const chip = () => within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem')[0]!;
    expect(chip()).toHaveAttribute('data-live', 'true');
    expect(chip()).toHaveTextContent('1.2 s');
    const m2 = msg([tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')]);
    rerender(<ThoughtLine message={m2} head={head(m2)} />);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(chip()).toHaveAttribute('data-state', 'done');
    expect(chip()).toHaveTextContent('1.2 s'); // frozen at the moment the next part came
    expect(within(chip()).getByLabelText('Done')).toBeInTheDocument();
  });

  it('FIX2 S-M1: the row and its live timer stay while the answer streams; the words only while it has no text', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START + 1_000);
    const m0 = msg([tool('skaz_search', 'Searched «entropy»')]);
    const { rerender, container } = render(<ThoughtLine message={m0} head={head(m0)} />);
    expect(screen.getByText('Writing an answer…')).toBeInTheDocument();
    // The agent writes a sentence, then keeps calling tools: the timer keeps running, the words go.
    const m1 = msg([text('Let me look.'), tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')]);
    rerender(<ThoughtLine message={m1} head={head(m1)} />);
    expect(screen.queryByText('Writing an answer…')).toBeNull();
    expect(screen.getByRole('timer')).toHaveTextContent('1.0 s');
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByRole('timer')).toHaveTextContent('3.0 s');
    expect(container.querySelector('.kb-thought__head canvas.kb-msg__think')).toHaveAttribute('aria-hidden', 'true');
    // An answer that streams text without any tool call has the timer row too.
    const m2 = msg([text('Entropy is…')]);
    rerender(<ThoughtLine message={m2} head={head(m2)} />);
    expect(screen.getByRole('timer')).toBeInTheDocument();
    // Finished: no timer row, no fold for an answer without tool calls.
    const m3 = msg([text('Entropy is…')], 'done');
    rerender(<ThoughtLine message={m3} head={head(m3)} />);
    expect(screen.queryByRole('timer')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('calls already there when the answer is opened get no invented timer', () => {
    const m = msg([tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')]);
    render(<ThoughtLine message={m} head={head(m)} />);
    for (const chip of within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem')) {
      expect(chip).not.toHaveAttribute('data-live');
      expect(chip.textContent).not.toMatch(/\d s$/);
    }
  });
});

describe('ThoughtLine after the answer', () => {
  it('folds into «Looked at N things» (with the total time it saw) and unfolds on click', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START + 500);
    const parts = [tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')];
    const working = msg(parts);
    const { rerender, container } = render(<ThoughtLine message={working} head={head(working)} />);
    vi.setSystemTime(START + 4_600);
    const done = msg([...parts, text('Entropy is…')], 'done');
    rerender(<ThoughtLine message={done} head={head(done)} />);
    const toggle = screen.getByRole('button', { name: /Looked at 2 things/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('4.6 s');
    expect(container.querySelector('.kb-thought')).toHaveAttribute('data-arrived', 'true');
    // Folded: the calls stay in the DOM for the fold motion, but out of reach.
    expect(container.querySelector('.kb-thought__fold')).toHaveAttribute('data-open', 'false');
    expect(container.querySelector('.kb-thought__fold')).toHaveAttribute('inert');
    vi.useRealTimers();
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.kb-thought__fold')).toHaveAttribute('data-open', 'true');
    expect(within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem').map((c) => c.getAttribute('data-state')))
      .toEqual(['done', 'done']);
  });

  it('an answer opened later is folded from the start, without the arrival motion or a made-up total', () => {
    const m = msg([tool('skaz_read_page', 'Read page Entropy'), text('Entropy is…')], 'done');
    const { container } = render(<ThoughtLine message={m} head={head(m)} />);
    const toggle = screen.getByRole('button', { name: /Looked at 1 thing/ });
    expect(toggle.textContent).not.toMatch(/\d s/);
    expect(container.querySelector('.kb-thought')).not.toHaveAttribute('data-arrived');
  });

  it('nothing at all for an answer that called no tools', () => {
    const { container } = render(<ThoughtLine message={msg([text('Hi')], 'done')} head={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Motion levels (full / calm / off)', () => {
  it('the block carries the effective level for its CSS: full, calm, off', () => {
    const m = msg([tool('skaz_search', 'Searched')]);
    const { container, rerender } = render(<ThoughtLine message={m} head={head(m)} />);
    expect(container.querySelector('.kb-thought')).toHaveAttribute('data-level', 'full');
    act(() => { document.documentElement.dataset.motion = 'calm'; });
    rerender(<ThoughtLine message={m} head={head(m)} />);
    expect(container.querySelector('.kb-thought')).toHaveAttribute('data-level', 'calm');
    act(() => { document.documentElement.dataset.motion = 'off'; });
    rerender(<ThoughtLine message={m} head={head(m)} />);
    expect(container.querySelector('.kb-thought')).toHaveAttribute('data-level', 'off');
  });
});

describe('CallChip error look (ready for a backend that reports failed calls)', () => {
  it('error = danger icon + words, no timer, no check', () => {
    render(<ul><CallChip call={{ index: 0, name: 'skaz_read_material', label: 'Read Textbook', state: 'error' }} /></ul>);
    const chip = screen.getByRole('listitem');
    expect(chip).toHaveAttribute('data-state', 'error');
    expect(chip).toHaveTextContent('Read Textbook');
    expect(chip).toHaveTextContent('failed');
    expect(within(chip).getByLabelText('Failed')).toBeInTheDocument();
  });
});
