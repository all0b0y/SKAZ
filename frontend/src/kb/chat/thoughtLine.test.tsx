import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbMessage, KbMessagePart } from '../../api/kb/types.gen';
import { CallChip, FOLD_UNMOUNT_MS, ThoughtLine, callStates, formatSeconds } from './ThoughtLine';

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
  it('FIX2 C-M3: parallel calls (back-to-back tool parts) all run until a non-tool part follows the group', () => {
    // Claude Code sends every tool_use of one turn before any result: two tool parts in a row are two
    // calls in flight, not one finished and one running.
    const parts = [tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')];
    expect(callStates(parts, 'streaming').map((c) => c.state)).toEqual(['run', 'run']);
    expect(callStates([...parts, text('Entropy is…')], 'streaming').map((c) => c.state)).toEqual(['done', 'done']);
    // Only the trailing group runs: calls before the last non-tool part are done.
    const more = [...parts, text('Now the textbook.'), tool('skaz_read_material', 'Read Textbook'), tool('skaz_search', 'Searched «W»')];
    expect(callStates(more, 'streaming').map((c) => c.state)).toEqual(['done', 'done', 'run', 'run']);
  });

  it('FIX2 C-M3: a permission or question after a call is the call waiting on the user, not its result', () => {
    const permission: KbMessagePart = { type: 'permission', id: 'perm-1' } as unknown as KbMessagePart;
    const question: KbMessagePart = { type: 'question', id: 'q-1' } as unknown as KbMessagePart;
    expect(callStates([tool('skaz_search', 'Searched'), permission], 'streaming').map((c) => c.state)).toEqual(['run']);
    expect(callStates([tool('skaz_search', 'Searched'), question], 'streaming').map((c) => c.state)).toEqual(['run']);
    expect(callStates([tool('skaz_search', 'Searched'), permission, text('Found it.')], 'streaming').map((c) => c.state)).toEqual(['done']);
  });

  it('a finished answer finished every call; a stopped one leaves its unfinished calls unfinished, not «done»', () => {
    const parts = [tool('skaz_search', 'Searched'), tool('skaz_read_page', 'Read page Entropy')];
    expect(callStates(parts, 'done').map((c) => c.state)).toEqual(['done', 'done']);
    expect(callStates(parts, 'cancelled').map((c) => c.state)).toEqual(['stopped', 'stopped']);
    expect(callStates(parts, 'interrupted').map((c) => c.state)).toEqual(['stopped', 'stopped']);
    expect(callStates([tool('skaz_search', 'Searched'), text('So…'), tool('skaz_read_page', 'Read')], 'cancelled').map((c) => c.state))
      .toEqual(['done', 'stopped']);
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
    // A second call in the same batch: both still run (FIX2 C-M3), the first one's timer keeps going.
    const m2 = msg([tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')]);
    rerender(<ThoughtLine message={m2} head={head(m2)} />);
    act(() => { vi.advanceTimersByTime(800); });
    expect(chip()).toHaveAttribute('data-state', 'run');
    expect(chip()).toHaveTextContent('2.0 s');
    const m3 = msg([...m2.parts, text('Entropy is…')]);
    rerender(<ThoughtLine message={m3} head={head(m3)} />);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(chip()).toHaveAttribute('data-state', 'done');
    expect(chip()).toHaveTextContent('2.0 s'); // frozen at the moment the answer went on past the calls
    expect(within(chip()).getByLabelText('Done')).toBeInTheDocument();
  });

  it('FIX2 C-M3: a call never seen running gets no duration (its start was not seen)', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START + 1_000);
    const m0 = msg([]);
    const { rerender } = render(<ThoughtLine message={m0} head={head(m0)} />);
    // The call and the text after it land in one update: it arrived on screen already done.
    const m1 = msg([tool('skaz_search', 'Searched «entropy»'), text('Entropy is…')]);
    rerender(<ThoughtLine message={m1} head={head(m1)} />);
    act(() => { vi.advanceTimersByTime(1_000); });
    const chip = within(screen.getByRole('list', { name: 'Tool calls' })).getByRole('listitem');
    expect(chip).toHaveAttribute('data-state', 'done');
    expect(chip).toHaveAttribute('data-live', 'true'); // it did arrive on screen: it may fade/wipe in
    expect(chip.querySelector('.kb-call__time')).toBeNull();
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

  it('FIX2 C-L6: folded answers unmount their chips once the fold motion ended; the «Looked at» line stays', async () => {
    const parts = [tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')];
    const empty = msg([]);
    const { rerender, container } = render(<ThoughtLine message={empty} head={head(empty)} />);
    const working = msg(parts); // both calls arrive on screen: arrivals
    rerender(<ThoughtLine message={working} head={head(working)} />);
    const done = msg([...parts, text('Entropy is…')], 'done');
    rerender(<ThoughtLine message={done} head={head(done)} />);
    const fold = container.querySelector('.kb-thought__fold')!;
    // During the fold the chips are still there (they fold away), out of reach.
    expect(fold.querySelectorAll('.kb-call')).toHaveLength(2);
    expect(fold.querySelector('.kb-call')).toHaveAttribute('data-live', 'true');
    // A transition of something inside does not count; the fold's own end does.
    fireEvent.transitionEnd(fold.querySelector('.kb-call')!);
    expect(fold.querySelectorAll('.kb-call')).toHaveLength(2);
    fireEvent.transitionEnd(fold);
    expect(container.querySelectorAll('.kb-call')).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'Tool calls' })).toBeNull();
    const toggle = screen.getByRole('button', { name: /Looked at 2 things/ });
    // Unfolding mounts them again; folding again unmounts them after the motion.
    await userEvent.setup().click(toggle);
    const again = within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem');
    expect(again).toHaveLength(2);
    // Mounted again by the unfold, they are not arrivals: no fade-in / wipe replay.
    for (const c of again) expect(c).not.toHaveAttribute('data-live');
    await userEvent.setup().click(toggle);
    expect(container.querySelectorAll('.kb-call')).toHaveLength(2);
    fireEvent.transitionEnd(container.querySelector('.kb-thought__fold')!);
    expect(container.querySelectorAll('.kb-call')).toHaveLength(0);
  });

  it('FIX2 C-L6: an answer opened later mounts no chips; without a transition end (off, hidden) they go after the fold time', () => {
    const m = msg([tool('skaz_read_page', 'Read page Entropy'), text('Entropy is…')], 'done');
    const { container, unmount } = render(<ThoughtLine message={m} head={head(m)} />);
    expect(container.querySelectorAll('.kb-call')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Looked at 1 thing/ })).toBeInTheDocument();
    unmount();
    vi.useFakeTimers();
    const working = msg([tool('skaz_search', 'Searched')]);
    const r = render(<ThoughtLine message={working} head={head(working)} />);
    const done = msg([tool('skaz_search', 'Searched'), text('So…')], 'done');
    r.rerender(<ThoughtLine message={done} head={head(done)} />);
    expect(r.container.querySelectorAll('.kb-call')).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(FOLD_UNMOUNT_MS); });
    expect(r.container.querySelectorAll('.kb-call')).toHaveLength(0);
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

describe('CallChip states for assistive tech (FIX2 C-L5)', () => {
  const chip = (state: 'run' | 'stopped' | 'done' | 'error') => {
    const { unmount } = render(<ul><CallChip call={{ index: 0, name: 'skaz_search', label: 'Searched «entropy»', state }} /></ul>);
    const li = screen.getByRole('listitem');
    const out = { text: li.textContent, hidden: Array.from(li.querySelectorAll('.kb-visually-hidden')).map((e) => e.textContent) };
    unmount();
    return out;
  };

  it('running and stopped are said in visually hidden words (the sweep and the dashed border are visual only)', () => {
    expect(chip('run').hidden).toEqual(['running']);
    expect(chip('run').text).toContain('Searched «entropy»');
    expect(chip('stopped').hidden).toEqual(['stopped']);
    // done and error already speak through their icons' labels / the visible «failed».
    expect(chip('done').hidden).toEqual([]);
    expect(chip('error').hidden).toEqual([]);
  });
});

describe('CallChip size (FIX2 S-L2)', () => {
  it('a chip is 26 px tall as in the demo B3, at every density (a component value, not --kb-control-h-sm)', () => {
    const css = readFileSync(resolve(__dirname, '../styles/chat.css'), 'utf8');
    const rule = /\n\.kb-call \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/(^|\n)\s*height: 26px;/);
    expect(rule).not.toMatch(/--kb-control-h/);
  });
});
