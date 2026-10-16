import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BridgeRequest } from '../../api/bridge';

let calls: BridgeRequest[];
let through: number;
let tailInvalidates: boolean;
let secondsPerEvent: number;
let TranscriptView: typeof import('./TranscriptView')['TranscriptView'];

function page(start: number, end: number) {
  const events = Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => {
    const n = start + i;
    const owner = { id: 'turn', connection_id: 'c', speaker_number: 1, start_sample: 0 };
    return { ordinal: n, segment_ids: [`s${n}`], originals_available: true,
      originals: [{ id: `o${n}`, connection_id: 'c', segment_id: `s${n}`, speaker_number: 1,
        start_sample: n * secondsPerEvent * 16000, end_sample: (n + 1) * secondsPerEvent * 16000, text: `Original ${n}. ` }],
      translations: [{ id: `t${n}`, connection_id: 'c', speaker_number: 1, text: `Перевод ${n}. ` }],
      order: [{ id: `o${n}`, translation_status: 'original' }, { id: `t${n}`, translation_status: 'translation' }],
      projection: { owners: { [`o${n}`]: owner }, translations: { [`t${n}`]: `g${n}` }, passthrough: [] },
    };
  });
  return { protocol: 1, session_id: 'native', recording_mode: 'translation', sample_rate: 16000,
    translation_target_language: 'ru', saved_samples: (through + 1) * 16000, transcription: 'streaming',
    connection: { id: 'c', start_sample: 0, end_sample: null, status: 'active',
      final_sample: (through + 1) * 16000, processed_sample: (through + 1) * 16000 },
    through, events, next_before: start, next_after: end, has_older: start > 0, has_newer: end < through,
    previous_connection_id: null, next_connection_id: null, tail: null,
    projection: { available: true, tail: null, tail_groups: tailInvalidates ? { g1: null } : {}, groups: Object.fromEntries(events.map(e =>
      [`g${e.ordinal}`, { id: 'turn', connection_id: 'c', speaker_number: 1, start_sample: 0 }])) },
  };
}

beforeEach(async () => {
  vi.resetModules(); calls = []; through = 1; tailInvalidates = false; secondsPerEvent = 1;
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  window.skaz = { ...window.skaz, request: vi.fn(async (req: BridgeRequest) => {
    calls.push(req);
    if (req.path === '/sessions/native/live/events') {
      const limit = Number(req.query?.limit ?? 128);
      const after = req.query?.after;
      const end = Math.min(through, req.query?.segment_id !== undefined ? Number(String(req.query.segment_id).slice(1)) + 63 : req.query?.before !== undefined ? Number(req.query.before) - 1
        : after !== undefined ? Number(after) + limit : through);
      const start = after !== undefined ? Number(after) + 1 : Math.max(0, end - limit + 1);
      return { ok: true, status: 200, data: page(start, end) } as never;
    }
    return { ok: false, status: 404, detail: 'Not found' } as never;
  }) };
  const { useStore } = await import('../../state/store');
  useStore.setState({ activeSessionId: 'native', recorderState: 'recording',
    detail: { segments: [], messages: [], notes: null }, detailLoading: false, detailError: null });
  TranscriptView = (await import('./TranscriptView')).TranscriptView;
});

it('renders translated event pages and polls deltas without full snapshot or detail reads', async () => {
  render(<TranscriptView focusSegmentId={null} />);
  expect(await screen.findByText('Перевод 0.')).toBeVisible();
  expect(screen.getByText('Перевод 1.')).toBeVisible();
  expect(screen.getByText('Original 0.')).not.toBeVisible();
  expect(screen.getByText('Original 1.')).not.toBeVisible();
  through = 2;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(await screen.findByText('Перевод 2.')).toBeVisible();
  expect(screen.getByText('Перевод 0.')).toBeVisible();
  expect(calls.some(c => c.query?.after === 1 && c.query?.connection_id === 'c')).toBe(true);
  expect(calls.filter(c => c.path === '/sessions/native' || c.path === '/sessions/native/live')).toHaveLength(0);
});

it('replaces provisional ownership when a mismatched draft retracts before a different final group', async () => {
  tailInvalidates = true;
  render(<TranscriptView focusSegmentId={null} />);
  expect(await screen.findByText('Translation not tied to an exact turn')).toBeVisible();
  tailInvalidates = false; through = 2;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  await screen.findByText('Перевод 2.');
  expect(screen.queryByText('Translation not tied to an exact turn')).toBeNull();
  expect(screen.getByText('Перевод 1.')).toBeVisible();
});

it('does not rebuild the history projection for unchanged delta polls', async () => {
  const { NativeHistory } = await import('./nativeHistory');
  const project = vi.spyOn(NativeHistory.prototype, 'snapshot');
  render(<TranscriptView focusSegmentId={null} />);
  await screen.findByText('Перевод 1.');
  const count = project.mock.calls.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(calls.some(call => call.query?.after === 1)).toBe(true);
  expect(project).toHaveBeenCalledTimes(count);
});

it('keeps an entire short recording available without a copy form or small window eviction', async () => {
  through = 1023;
  render(<TranscriptView focusSegmentId={null} />);
  expect(await screen.findByText('Original 0.')).toBeInTheDocument();
  expect(screen.getByText('Original 1023.')).toBeInTheDocument();
  expect(screen.queryByText('Копировать оригинал по времени')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Ранее' })).toBeNull();
});

it('opens whole adjacent time parts and remounts the same speaker without retaining the other part', async () => {
  through = 119; secondsPerEvent = 30;
  const view = render(<TranscriptView focusSegmentId={null} />);
  await screen.findByText('Перевод 119.');
  expect(screen.getByText('Перевод 60.')).toBeVisible();
  expect(screen.queryByText('Original 0.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Предыдущая часть' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Следующая часть' })).toBeNull();
  const scroller = view.container.querySelector('.transcript')!;
  Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
  scroller.scrollTop = 0;
  fireEvent.wheel(scroller, { deltaY: -100 });
  expect(await screen.findByText('Перевод 0.')).toBeVisible();
  expect(screen.getByText('Перевод 59.')).toBeVisible();
  expect(screen.queryByText('Перевод 60.')).toBeNull();
  fireEvent.click(screen.getByText('Show original'));
  expect(screen.getByText('Original 0.')).toBeVisible();
  expect(screen.getByText('Speaker 1')).toBeVisible();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 480)); });
  scroller.scrollTop = 900;
  fireEvent.wheel(scroller, { deltaY: 100 });
  expect(await screen.findByText('Перевод 60.')).toBeVisible();
  expect(screen.getByText('Speaker 1')).toBeVisible();
  expect(screen.queryByText('Original 0.')).toBeNull();
});

it('opens the cited part, reveals and highlights its source, and pauses following new speech', async () => {
  through = 119; secondsPerEvent = 30;
  const view = render(<TranscriptView focusSegmentId={null} />);
  await screen.findByText('Перевод 119.');
  view.rerender(<TranscriptView focusSegmentId="s0" />);
  expect(await screen.findByText('Original 0.')).toBeVisible();
  expect(screen.getByText('Original 0.')).toHaveClass('segment--focused');
  expect(screen.queryByText('Перевод 119.')).toBeNull();
  through = 120;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(screen.getByText('Original 0.')).toBeVisible();
  expect(screen.queryByText('Перевод 120.')).toBeNull();
  const follow = screen.getByRole('button', { name: 'Jump to live' });
  // Live speech keeps arriving below the reader: the pill says so with a dot.
  expect(follow.querySelector('.transcript__follow-live')).not.toBeNull();
  expect(follow.querySelector('svg')).not.toBeNull();
  fireEvent.click(follow);
  expect(await screen.findByText('Перевод 120.')).toBeVisible();
  expect(screen.queryByText('Original 0.')).toBeNull();
  expect(calls.filter(c => c.path === '/sessions/native' || c.path === '/sessions/native/live')).toHaveLength(0);
});

it('automatically opens the next part only while following live speech', async () => {
  through = 59; secondsPerEvent = 30;
  render(<TranscriptView focusSegmentId={null} />);
  await screen.findByText('Перевод 59.');
  through = 60;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(await screen.findByText('Перевод 60.')).toBeVisible();
  expect(screen.queryByText('Перевод 0.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Предыдущая часть' })).toBeNull();
});

it('crosses part boundaries by vertical scrolling without numbered pagination', async () => {
  through = 119; secondsPerEvent = 30;
  const view = render(<TranscriptView focusSegmentId={null} />);
  await screen.findByText('Перевод 119.');
  const scroller = view.container.querySelector('.transcript')!;
  Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
  scroller.scrollTop = 0;
  fireEvent.wheel(scroller, { deltaY: -100 });
  expect(await screen.findByText('Перевод 0.')).toBeVisible();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 480)); });
  scroller.scrollTop = 900;
  fireEvent.wheel(scroller, { deltaY: 100 });
  expect(await screen.findByText('Перевод 119.')).toBeVisible();
  expect(screen.queryByText('Original 0.')).toBeNull();
});
