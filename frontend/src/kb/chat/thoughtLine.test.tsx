import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbMessage, KbMessagePart } from '../../api/kb/types.gen';
import { auditCss } from '../board/audit';
import { CallChip, FOLD_UNMOUNT_MS, ThoughtLine, callStates, formatSeconds } from './ThoughtLine';

// Stage 6 B3 (decision 30): ThoughtLine + CallChip. While the agent works: the thinking line with a
// live timer and one chip per tool call; after the answer it folds into «N tool calls».

const START = Date.parse('2026-10-28T10:00:00Z');
const tool = (name: string, label: string, meta: Partial<Extract<KbMessagePart, { type: 'tool' }>> = {}): KbMessagePart =>
  ({ type: 'tool', name, label, status: 'running', ...meta });
const doneTools = (parts: KbMessagePart[]): KbMessagePart[] => parts.map<KbMessagePart>((p) =>
  p.type === 'tool' ? { ...p, status: 'done' } : p);
const text = (t: string): KbMessagePart => ({ type: 'text', text: t });
function msg(parts: KbMessagePart[], state: KbMessage['state'] = 'streaming'): KbMessage {
  return {
    id: 'a1', seq: 2, role: 'assistant', created_at: new Date(START).toISOString(), engine: 'claude_code', model: 'opus',
    state, parts, failure: null, saved_page_id: null, input: null,
  };
}
const head = (m: KbMessage) => (m.state === 'streaming' && m.parts.every((p) => p.type === 'tool') ? 'Writing an answer…' : null);

afterEach(() => { cleanup(); vi.useRealTimers(); delete document.documentElement.dataset.motion; });

describe('callStates: only explicit persisted tool outcomes', () => {
  it('parallel calls stay running when another call or text follows, until their own result', () => {
    const parts = [tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')];
    expect(callStates(parts, 'streaming').map((c) => c.state)).toEqual(['run', 'run']);
    expect(callStates([...parts, text('Entropy is…')], 'streaming').map((c) => c.state)).toEqual(['run', 'run']);
    const more = [...parts, text('Now the textbook.'), tool('skaz_read_material', 'Read Textbook'), tool('skaz_search', 'Searched «W»')];
    expect(callStates(more, 'streaming').map((c) => c.state)).toEqual(['run', 'run', 'run', 'run']);
  });

  it('a permission, question or following text never completes a call waiting on the user', () => {
    const permission = { type: 'permission', id: 'perm-1' } as unknown as KbMessagePart;
    const question = { type: 'question', id: 'q-1' } as unknown as KbMessagePart;
    expect(callStates([tool('skaz_search', 'Searched'), permission], 'streaming').map((c) => c.state)).toEqual(['run']);
    expect(callStates([tool('skaz_search', 'Searched'), question], 'streaming').map((c) => c.state)).toEqual(['run']);
    expect(callStates([tool('skaz_search', 'Searched'), permission, text('Found it.')], 'streaming').map((c) => c.state)).toEqual(['run']);
  });

  it('an answer end cannot invent success or a result; explicit final outcomes survive', () => {
    const parts = [tool('skaz_search', 'Searched', { status: 'done' }), tool('skaz_read_page', 'Read page Entropy')];
    for (const state of ['done', 'cancelled', 'interrupted'] as const) {
      expect(callStates(parts, state).map((c) => c.state)).toEqual(['done', 'unknown']);
    }
    expect(callStates([parts[0]!, text('So…'), tool('skaz_read_page', 'Read', { status: 'stopped' })], 'cancelled').map((c) => c.state))
      .toEqual(['done', 'stopped']);
  });

  it('web search keeps its own detail card and is not a duplicate chip (W-3b)', () => {
    expect(callStates([tool('mcp__skaz__skaz_web_search', 'Used web search'), tool('skaz_search', 'Searched', { status: 'done' })], 'done'))
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
    const status = screen.getByText('Writing an answer…').closest('[role="status"]')!;
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
    expect(screen.queryByRole('button', { name: /tool calls?/ })).toBeNull();
  });

  it('a call seen live gets its own timer that stops when it is done; it then shows a check', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START + 1_000);
    const m0 = msg([]);
    const { rerender } = render(<ThoughtLine message={m0} head={head(m0)} />);
    const m1 = msg([tool('skaz_search', 'Searched «entropy»', { started_at: new Date(START + 1_000).toISOString() })]);
    rerender(<ThoughtLine message={m1} head={head(m1)} />);
    act(() => { vi.advanceTimersByTime(1_200); });
    const chip = () => within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem')[0]!;
    expect(chip()).toHaveAttribute('data-live', 'true');
    expect(chip()).toHaveTextContent('1.2 s');
    // A second call in the same batch: both still run (FIX2 C-M3), the first one's timer keeps going.
    const m2 = msg([...m1.parts, tool('skaz_read_page', 'Read page Entropy')]);
    rerender(<ThoughtLine message={m2} head={head(m2)} />);
    act(() => { vi.advanceTimersByTime(800); });
    expect(chip()).toHaveAttribute('data-state', 'run');
    expect(chip()).toHaveTextContent('2.0 s');
    const m3 = msg([tool('skaz_search', 'Searched «entropy»', { status: 'done', duration_ms: 2_000 }),
      tool('skaz_read_page', 'Read page Entropy', { status: 'done', duration_ms: 800 }), text('Entropy is…')]);
    rerender(<ThoughtLine message={m3} head={head(m3)} />);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(chip()).toHaveAttribute('data-state', 'done');
    expect(chip()).toHaveTextContent('2.0 s'); // the measured backend duration, not when the following text arrived
    expect(within(chip()).getByLabelText('Done')).toBeInTheDocument();
  });

  it('a call without stored timing gets no invented duration even when already completed', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START + 1_000);
    const m0 = msg([]);
    const { rerender } = render(<ThoughtLine message={m0} head={head(m0)} />);
    // The call and the text after it land in one update: it arrived on screen already done.
    const m1 = msg([tool('skaz_search', 'Searched «entropy»', { status: 'done' }), text('Entropy is…')]);
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
  it('folds into «N tool calls» (with the total time it saw) and unfolds on click', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START + 500);
    const parts = [tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')];
    const working = msg(parts);
    const { rerender, container } = render(<ThoughtLine message={working} head={head(working)} />);
    vi.setSystemTime(START + 4_600);
    const done = msg([...doneTools(parts), text('Entropy is…')], 'done');
    rerender(<ThoughtLine message={done} head={head(done)} />);
    const toggle = screen.getByRole('button', { name: /2 tool calls/ });
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
    const toggle = screen.getByRole('button', { name: /1 tool call/ });
    expect(toggle.textContent).not.toMatch(/\d s/);
    expect(container.querySelector('.kb-thought')).not.toHaveAttribute('data-arrived');
  });

  it('FIX2 C-L6: folded answers unmount their chips once the fold motion ended; the call-count line stays', async () => {
    const parts = [tool('skaz_search', 'Searched «entropy»'), tool('skaz_read_page', 'Read page Entropy')];
    const empty = msg([]);
    const { rerender, container } = render(<ThoughtLine message={empty} head={head(empty)} />);
    const working = msg(parts); // both calls arrive on screen: arrivals
    rerender(<ThoughtLine message={working} head={head(working)} />);
    const done = msg([...doneTools(parts), text('Entropy is…')], 'done');
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
    const toggle = screen.getByRole('button', { name: /2 tool calls/ });
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
    expect(screen.getByRole('button', { name: /1 tool call/ })).toBeInTheDocument();
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
  it('the block carries the effective level for its CSS: full, calm, off', async () => {
    const m = msg([tool('skaz_search', 'Searched')]);
    const { container, rerender } = render(<ThoughtLine message={m} head={head(m)} />);
    expect(container.querySelector('.kb-thought')).toHaveAttribute('data-level', 'full');
    await act(async () => {
      document.documentElement.dataset.motion = 'calm';
      rerender(<ThoughtLine message={m} head={head(m)} />);
    });
    expect(container.querySelector('.kb-thought')).toHaveAttribute('data-level', 'calm');
    await act(async () => {
      document.documentElement.dataset.motion = 'off';
      rerender(<ThoughtLine message={m} head={head(m)} />);
    });
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

const makeTools = (count: number, status: 'running' | 'done' = 'done'): KbMessagePart[] =>
  Array.from({ length: count }, (_, i) => tool('skaz_search', `Call #${i + 1}`, {
    status,
    ...(status === 'done' ? { duration_ms: (i + 1) * 100 } : {}),
  }));

describe('Earlier tool-calls collapse (A3 / item 07)', () => {
  it('shows all chips through 5 without an earlier-calls trigger', () => {
    const m = msg(makeTools(5), 'streaming');
    const { container } = render(<ThoughtLine message={m} head={head(m)} />);
    const calls = within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem');
    expect(calls).toHaveLength(5);
    expect(calls.map((c) => c.querySelector('.kb-call__label')?.textContent)).toEqual([
      'Call #1', 'Call #2', 'Call #3', 'Call #4', 'Call #5',
    ]);
    expect(container.querySelector('.kb-thought__earlier-trigger')).toBeNull();
    expect(container.querySelector('.kb-thought__earlier-fold')).toBeNull();
  });

  it('from the 6th arrival onward, collapses earlier calls behind an arrowless trigger and keeps 5 latest visible', () => {
    const m5 = msg(makeTools(5), 'streaming');
    const { container, rerender } = render(<ThoughtLine message={m5} head={head(m5)} />);
    expect(container.querySelector('.kb-thought__earlier-trigger')).toBeNull();

    // 6th call arrives: 1 earlier call behind trigger, calls #2..#6 visible.
    const m6 = msg(makeTools(6), 'streaming');
    rerender(<ThoughtLine message={m6} head={head(m6)} />);
    const trigger = screen.getByRole('button', { name: /1 earlier/i });
    expect(trigger).toHaveTextContent('1 earlier call');
    expect(trigger).toHaveAccessibleName('1 earlier call');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.querySelectorAll('svg')).toHaveLength(0);

    const visibleLabels = within(screen.getByRole('list', { name: 'Tool calls' }))
      .getAllByRole('listitem')
      .map((c) => c.querySelector('.kb-call__label')?.textContent);
    expect(visibleLabels).toEqual(['Call #2', 'Call #3', 'Call #4', 'Call #5', 'Call #6']);

    const folder = container.querySelector('.kb-thought__earlier-fold')!;
    expect(folder).toHaveAttribute('data-open', 'false');
    expect(folder).toHaveAttribute('aria-hidden', 'true');
    expect(folder).toHaveAttribute('inert');
    expect(trigger).toHaveAttribute('aria-controls', folder.id);
    expect(folder.querySelectorAll('.kb-call')).toHaveLength(1);
    expect(folder.querySelector('.kb-call__label')).toHaveTextContent('Call #1');

    // 7th call arrives: trigger increments to "2 earlier calls" with sliding window #3..#7.
    const m7 = msg(makeTools(7), 'streaming');
    rerender(<ThoughtLine message={m7} head={head(m7)} />);
    expect(trigger).toHaveTextContent('2 earlier calls');
    expect(within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem')
      .map((c) => c.querySelector('.kb-call__label')?.textContent)).toEqual([
      'Call #3', 'Call #4', 'Call #5', 'Call #6', 'Call #7',
    ]);
    expect(Array.from(folder.querySelectorAll('.kb-call__label')).map((e) => e.textContent)).toEqual([
      'Call #1', 'Call #2',
    ]);
  });

  it('handles 18 calls (13 earlier calls + 5 latest) when unfolded after completion', async () => {
    const user = userEvent.setup();
    const m = msg([...makeTools(18), text('Answer')], 'done');
    const { container } = render(<ThoughtLine message={m} head={null} />);

    // Initially folded behind "18 tool calls".
    const sumToggle = screen.getByRole('button', { name: /18 tool calls/ });
    expect(container.querySelector('.kb-thought__earlier-trigger')).toBeNull();

    await user.click(sumToggle);
    const trigger = screen.getByRole('button', { name: /13 earlier/i });
    expect(trigger).toHaveTextContent('13 earlier calls');
    expect(trigger).toHaveAccessibleName('13 earlier calls');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.querySelectorAll('svg')).toHaveLength(0);

    expect(within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem')
      .map((c) => c.querySelector('.kb-call__label')?.textContent)).toEqual([
      'Call #14', 'Call #15', 'Call #16', 'Call #17', 'Call #18',
    ]);
    const folder = container.querySelector('.kb-thought__earlier-fold')!;
    expect(folder).toHaveAttribute('data-open', 'false');
    expect(folder.querySelectorAll('.kb-call')).toHaveLength(13);
  });

  it('only hovering the trigger opens; moving into the revealed group keeps it open; leaving closes it', async () => {
    const user = userEvent.setup();
    const m = msg(makeTools(18), 'streaming');
    const { container } = render(<ThoughtLine message={m} head={head(m)} />);
    const trigger = screen.getByRole('button', { name: /13 earlier/i });
    const folder = container.querySelector('.kb-thought__earlier-fold')!;
    const latestChip = within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem')[0]!;

    // Hovering a latest chip or the family container does NOT open the earlier calls.
    await user.hover(latestChip);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(folder).toHaveAttribute('data-open', 'false');
    await user.unhover(latestChip);

    // Hovering the trigger opens it and exposes the 13 earlier calls.
    await user.hover(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(folder).toHaveAttribute('data-open', 'true');
    expect(folder).not.toHaveAttribute('aria-hidden');
    expect(folder).not.toHaveAttribute('inert');
    const earlierList = screen.getByRole('list', { name: 'Earlier tool calls' });
    const firstEarlierChip = within(earlierList).getAllByRole('listitem')[0]!;

    // Moving pointer into the revealed group keeps it open.
    await user.hover(firstEarlierChip);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(folder).toHaveAttribute('data-open', 'true');

    // Leaving the group closes it.
    await user.unhover(firstEarlierChip);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(folder).toHaveAttribute('data-open', 'false');
    expect(folder).toHaveAttribute('aria-hidden', 'true');
    expect(folder).toHaveAttribute('inert');

    // Clicking the trigger with a pointer and then leaving still closes it (pointer focus does not pin it).
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.unhover(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('resets open earlier group and unmounts all chips when the finished answer folds away', async () => {
    const user = userEvent.setup();
    const parts = makeTools(7);
    const { container, rerender } = render(<ThoughtLine message={msg(parts, 'streaming')} head={null} />);
    await user.hover(screen.getByRole('button', { name: /2 earlier/i }));
    expect(container.querySelector('.kb-thought__earlier-fold')).toHaveAttribute('data-open', 'true');

    rerender(<ThoughtLine message={msg([...parts, text('Done')], 'done')} head={null} />);
    const outerFold = container.querySelector('.kb-thought__fold')!;
    expect(outerFold).toHaveAttribute('data-open', 'false');
    expect(outerFold).toHaveAttribute('inert');
    fireEvent.transitionEnd(outerFold);
    expect(container.querySelectorAll('.kb-call')).toHaveLength(0);
    expect(container.querySelector('.kb-thought__earlier-trigger')).toBeNull();

    // Unfolding the finished summary mounts the trigger in its collapsed state again.
    await user.click(screen.getByRole('button', { name: /7 tool calls/ }));
    expect(screen.getByRole('button', { name: /2 earlier/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keyboard focus on the trigger opens; Escape dismisses without bubbling; blur closes and refocus reopens', async () => {
    const user = userEvent.setup();
    const outerKeyDown = vi.fn();
    const m = msg(makeTools(8), 'streaming');
    const { container } = render(
      <div onKeyDown={outerKeyDown}>
        <ThoughtLine message={m} head={head(m)} />
        <button type="button">After</button>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: /3 earlier/i });
    const folder = container.querySelector('.kb-thought__earlier-fold')!;

    // Tab onto trigger -> opens.
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(folder).toHaveAttribute('data-open', 'true');

    // Escape closes and stops propagation.
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(folder).toHaveAttribute('data-open', 'false');
    expect(folder).toHaveAttribute('inert');
    expect(outerKeyDown).not.toHaveBeenCalled();

    // Tab away -> Escape on outside button bubbles normally; Tab back -> reopens.
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(folder).toHaveAttribute('data-open', 'true');

    // Blur out closes it.
    await user.tab();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(folder).toHaveAttribute('data-open', 'false');
  });

  it('stationary trigger: visible row precedes earlier folder in DOM, geometry is stable, and trigger does not shift on hover/open', async () => {
    const user = userEvent.setup();
    const m = msg(makeTools(10), 'streaming');
    const { container } = render(<ThoughtLine message={m} head={head(m)} />);
    const family = container.querySelector('.kb-thought__family')!;
    const visible = family.querySelector('.kb-thought__visible')!;
    const folder = family.querySelector('.kb-thought__earlier-fold')!;
    const trigger = screen.getByRole('button', { name: /5 earlier/i });

    // Visible row (trigger + latest 5) is placed before the earlier-calls fold so expanding downward cannot move the trigger.
    expect(visible.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const before = trigger.getBoundingClientRect();
    await user.hover(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const after = trigger.getBoundingClientRect();
    expect(after).toEqual(before);

    // Sibling CSS does not transform, scale or resize the trigger on hover/open, and obeys token lint.
    const css = readFileSync(resolve(__dirname, './thoughtLine.css'), 'utf8');
    expect(css).not.toMatch(/\.kb-thought__earlier-trigger[^}]*transform\s*:/);
    const audit = auditCss({ 'kb/chat/thoughtLine.css': css });
    expect(audit.colors).toEqual([]);
    expect(audit.fontSizes.filter((t) => !t.value.endsWith('em'))).toEqual([]);
    expect(audit.radii).toEqual([]);
    expect(audit.spacing.filter((s) => s.value !== '1px' && parseFloat(s.value) <= 34)).toEqual([]);
    expect(audit.shadows).toBe(0);
  });

  it('respects reduced motion (calm/off and prefers-reduced-motion) while preserving open/close behavior', async () => {
    const user = userEvent.setup();
    document.documentElement.dataset.motion = 'calm';
    const m = msg(makeTools(8), 'streaming');
    const { container, rerender } = render(<ThoughtLine message={m} head={head(m)} />);
    expect(container.querySelector('.kb-thought')).toHaveAttribute('data-level', 'calm');

    const trigger = screen.getByRole('button', { name: /3 earlier/i });
    const folder = container.querySelector('.kb-thought__earlier-fold')!;
    await user.hover(trigger);
    expect(folder).toHaveAttribute('data-open', 'true');
    await user.unhover(trigger);
    expect(folder).toHaveAttribute('data-open', 'false');

    await act(async () => {
      document.documentElement.dataset.motion = 'off';
      rerender(<ThoughtLine message={m} head={head(m)} />);
    });
    expect(container.querySelector('.kb-thought')).toHaveAttribute('data-level', 'off');
    await user.hover(trigger);
    expect(folder).toHaveAttribute('data-open', 'true');

    const css = readFileSync(resolve(__dirname, './thoughtLine.css'), 'utf8');
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/data-motion=['"]calm['"]/);
    expect(css).toMatch(/data-motion=['"]off['"]/);
  });
});
