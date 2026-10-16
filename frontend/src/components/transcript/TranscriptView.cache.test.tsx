import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BridgeRequest } from '../../api/bridge';

/** Returning to a transcript reuses the in-memory history instead of re-reading it. */
let calls: BridgeRequest[];
let through: Record<string, number>;
let secondsPerEvent: number;
let TranscriptView: typeof import('./TranscriptView')['TranscriptView'];
let useStore: typeof import('../../state/store')['useStore'];

function page(session: string, start: number, end: number) {
  const last = through[session]!;
  const events = Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => {
    const n = start + i;
    const owner = { id: 'turn', connection_id: 'c', speaker_number: 1, start_sample: 0 };
    return { ordinal: n, segment_ids: [`s${n}`], originals_available: true,
      originals: [{ id: `o${n}`, connection_id: 'c', segment_id: `s${n}`, speaker_number: 1,
        start_sample: n * secondsPerEvent * 16000, end_sample: (n + 1) * secondsPerEvent * 16000, text: `Original ${n}. ` }],
      translations: [{ id: `t${n}`, connection_id: 'c', speaker_number: 1, text: `${session}-перевод ${n}. ` }],
      order: [{ id: `o${n}`, translation_status: 'original' }, { id: `t${n}`, translation_status: 'translation' }],
      projection: { owners: { [`o${n}`]: owner }, translations: { [`t${n}`]: `g${n}` }, passthrough: [] },
    };
  });
  return { protocol: 1, session_id: session, recording_mode: 'translation', sample_rate: 16000,
    translation_target_language: 'ru', saved_samples: (last + 1) * 16000, transcription: 'streaming',
    connection: { id: 'c', start_sample: 0, end_sample: null, status: 'active',
      final_sample: (last + 1) * 16000, processed_sample: (last + 1) * 16000 },
    through: last, events, next_before: start, next_after: end, has_older: start > 0, has_newer: end < last,
    previous_connection_id: null, next_connection_id: null, tail: null,
    projection: { available: true, tail: null, tail_groups: {}, groups: Object.fromEntries(events.map(e =>
      [`g${e.ordinal}`, { id: 'turn', connection_id: 'c', speaker_number: 1, start_sample: 0 }])) },
  };
}

const events = (id: string) => calls.filter(c => c.path === `/sessions/${id}/live/events`);
/** A cursor-less read is the start of a full history load. */
const fullLoads = (id: string) => events(id).filter(c => c.query?.connection_id === undefined).length;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });

function open(id: string) {
  useStore.setState({ activeSessionId: id });
  return render(<TranscriptView focusSegmentId={null} />);
}

beforeEach(async () => {
  vi.resetModules(); calls = []; through = { a: 300, b: 3, c: 3 }; secondsPerEvent = 1;
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  window.skaz = { ...window.skaz, request: vi.fn(async (req: BridgeRequest) => {
    calls.push(req);
    if (req.method === 'DELETE') return { ok: true, status: 200, data: { deleted: true } } as never;
    const session = /^\/sessions\/([^/]+)\/live\/events$/.exec(req.path)?.[1];
    if (session) {
      const limit = Number(req.query?.limit ?? 128);
      const after = req.query?.after;
      const last = through[session]!;
      const end = Math.min(last, req.query?.before !== undefined ? Number(req.query.before) - 1
        : after !== undefined ? Number(after) + limit : last);
      const start = after !== undefined ? Number(after) + 1 : Math.max(0, end - limit + 1);
      return { ok: true, status: 200, data: page(session, start, end) } as never;
    }
    return { ok: false, status: 404, detail: 'Not found' } as never;
  }) };
  ({ useStore } = await import('../../state/store'));
  useStore.setState({ activeSessionId: 'a', recorderState: 'idle', sessions: [],
    detail: { segments: [], messages: [], notes: null }, detailLoading: false, detailError: null });
  TranscriptView = (await import('./TranscriptView')).TranscriptView;
});

it('shows the cached transcript at once on return and reads only the new events', async () => {
  const first = open('a');
  await screen.findByText('a-перевод 300.');
  expect(events('a').some(c => c.query?.before !== undefined)).toBe(true);
  first.unmount();
  const before = calls.length;
  through.a = 301;
  open('a');
  expect(screen.getByText('a-перевод 0.')).toBeInTheDocument();
  expect(screen.getByText('a-перевод 300.')).toBeInTheDocument();
  expect(await screen.findByText('a-перевод 301.')).toBeInTheDocument();
  const resumed = calls.slice(before);
  expect(resumed.length).toBeGreaterThan(0);
  expect(resumed.every(c => c.query?.connection_id === 'c' && c.query?.after !== undefined)).toBe(true);
});

it('keeps the two most recently opened sessions and reloads an evicted one', async () => {
  for (const [id, text] of [['a', 'a-перевод 300.'], ['b', 'b-перевод 3.'], ['a', 'a-перевод 300.']] as const) {
    const view = open(id);
    await screen.findByText(text);
    await settle();
    view.unmount();
  }
  expect(fullLoads('a')).toBe(1);
  for (const [id, text] of [['b', 'b-перевод 3.'], ['c', 'c-перевод 3.'], ['a', 'a-перевод 300.']] as const) {
    const view = open(id);
    await screen.findByText(text);
    await settle();
    view.unmount();
  }
  expect(fullLoads('b')).toBe(1);
  expect(fullLoads('a')).toBe(2);
});

it('returns a reader who left live following to the same part and scroll position', async () => {
  through.a = 119; secondsPerEvent = 30;
  const first = open('a');
  await screen.findByText('a-перевод 119.');
  const scroller = first.container.querySelector('.transcript')!;
  Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
  scroller.scrollTop = 0;
  fireEvent.wheel(scroller, { deltaY: -100 });
  await screen.findByText('a-перевод 0.');
  scroller.scrollTop = 250;
  first.unmount();
  through.a = 120;
  const second = open('a');
  expect(screen.getByText('a-перевод 0.')).toBeInTheDocument();
  expect(screen.queryByText('a-перевод 119.')).toBeNull();
  expect(second.container.querySelector('.transcript')!.scrollTop).toBe(250);
  await settle();
  expect(screen.getByText('a-перевод 0.')).toBeInTheDocument();
  expect(screen.queryByText('a-перевод 120.')).toBeNull();
});

it('drops the cached history on retry', async () => {
  const { useNativeTranscript } = await import('./useNativeTranscript');
  const hook = renderHook(() => useNativeTranscript('b', false));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  expect(fullLoads('b')).toBe(1);
  act(() => { hook.result.current.retry(); });
  await waitFor(() => expect(fullLoads('b')).toBe(2));
});

it('forgets a deleted session', async () => {
  const cache = await import('./transcriptCache');
  const view = open('b');
  await screen.findByText('b-перевод 3.');
  view.unmount();
  expect(cache.peekTranscript('b')?.ready).toBe(true);
  await act(async () => { await useStore.getState().removeSession('b'); });
  expect(cache.peekTranscript('b')).toBeUndefined();
});
