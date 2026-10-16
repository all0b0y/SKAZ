import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeRequest } from '../../api/bridge';

/**
 * The transcript screen has one read path (event pages) and a small fixed set of
 * states — CODEX-DMG-TRANSCRIPT-FIX-SPEC §4. No legacy snapshot screen, no
 * pulsing "Listening…", no loader → logo → text flicker while recording.
 * Translation, speaker turns and citations over event pages are covered by
 * TranscriptView.window.test.tsx and nativeMonologues.dom.test.tsx.
 */
let TranscriptView: (typeof import('./TranscriptView'))['TranscriptView'];
let useStore: (typeof import('../../state/store'))['useStore'];
let RecorderBar: (typeof import('../recorder/RecorderBar'))['RecorderBar'];
let calls: BridgeRequest[];
/** null: the recording does not exist yet (404). Otherwise the stored words. */
let words: string[] | null;
let transcription: string;
let failReads: boolean;

function page(start: number, end: number) {
  const list = words ?? [];
  const events = list.slice(start, end + 1).map((text, i) => {
    const n = start + i;
    const owner = { id: 'turn', connection_id: 'c', speaker_number: 1, start_sample: 0 };
    return { ordinal: n, segment_ids: [`s${n}`], originals_available: true,
      originals: [{ id: `o${n}`, connection_id: 'c', segment_id: `s${n}`, speaker_number: 1,
        start_sample: n * 16000, end_sample: (n + 1) * 16000, text }],
      translations: [], order: [{ id: `o${n}`, translation_status: 'original' }],
      projection: { owners: { [`o${n}`]: owner }, translations: {}, passthrough: [] } };
  });
  const through = list.length - 1;
  return { protocol: 1, session_id: 'native', recording_mode: 'transcription', sample_rate: 16000,
    translation_target_language: null, saved_samples: list.length * 16000, transcription,
    connection: { id: 'c', start_sample: 0, end_sample: null, status: 'active',
      final_sample: list.length * 16000, processed_sample: list.length * 16000 },
    through, events, next_before: start, next_after: Math.max(end, through), has_older: false, has_newer: false,
    previous_connection_id: null, next_connection_id: null, tail: null,
    projection: { available: true, tail: null, tail_groups: {}, groups: {} } };
}

beforeEach(async () => {
  vi.resetModules(); calls = []; words = ['Confirmed text.']; transcription = 'streaming'; failReads = false;
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  window.skaz = { ...window.skaz, request: vi.fn(async (req: BridgeRequest) => {
    calls.push(req);
    if (req.path === '/sessions/native/live/events') {
      if (failReads) return { ok: false, status: 503, detail: 'Unavailable' } as never;
      if (words === null) return { ok: false, status: 404, detail: 'Native recording does not exist.' } as never;
      const after = req.query?.after;
      const start = after !== undefined ? Number(after) + 1 : 0;
      return { ok: true, status: 200, data: page(start, Math.max(start, words.length - 1)) } as never;
    }
    return { ok: false, status: 404, detail: 'Not found' } as never;
  }) };
  useStore = (await import('../../state/store')).useStore;
  useStore.setState({ activeSessionId: 'native', recorderState: 'recording', sessions: [],
    detail: { segments: [], messages: [], notes: null }, detailLoading: false, detailError: null });
  TranscriptView = (await import('./TranscriptView')).TranscriptView;
  RecorderBar = (await import('../recorder/RecorderBar')).RecorderBar;
});

/**
 * Critical transcript problems are shown in the recorder capsule, not in a strip
 * over the text (.dev/docs/UI-CLEANUP-IMPORT-TRANSCRIPT-SPEC.md §1).
 */
const withRecorder = () => (<><TranscriptView focusSegmentId={null} /><RecorderBar /></>);
afterEach(() => { vi.useRealTimers(); });

const eventReads = () => calls.filter((c) => c.path === '/sessions/native/live/events').length;
const legacyReads = () => calls.filter((c) => c.path === '/sessions/native/live' || c.path === '/sessions/native').length;

describe('transcript screen states', () => {
  it('waits statically while a just-started recording does not exist yet, then shows its words', async () => {
    vi.useFakeTimers();
    words = null;
    render(<TranscriptView focusSegmentId={null} />);
    await act(async () => {});
    expect(screen.getByText('Recording — waiting for first words')).toBeInTheDocument();
    expect(screen.getByText('Soniox: connecting')).toBeInTheDocument();
    // No legacy screen, no pulse, no loader during capture.
    expect(screen.queryByText('Listening…')).not.toBeInTheDocument();
    expect(document.querySelector('.transcript__pulse')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading transcript' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Soniox transcription')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.queryByRole('status', { name: 'Loading transcript' })).not.toBeInTheDocument();

    // The recording is created and the first words arrive; polling picks them up.
    words = ['First words.'];
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(screen.getByText('First words.')).toBeInTheDocument();
    expect(screen.queryByText('Recording — waiting for first words')).not.toBeInTheDocument();
    expect(legacyReads()).toBe(0);
  });

  it('keeps the same waiting state when the stream is open but nothing is said yet', async () => {
    words = []; transcription = 'streaming';
    render(<TranscriptView focusSegmentId={null} />);
    expect(await screen.findByText('Soniox: transcribing')).toBeInTheDocument();
    expect(screen.getByText('Recording — waiting for first words')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Transcript' })).not.toBeInTheDocument();
  });

  it('shows the recording as soon as words exist, with the unavailable notice in the recorder when Soniox fails', async () => {
    transcription = 'unavailable';
    const { container } = render(withRecorder());
    expect(await screen.findByText('Confirmed text.')).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Recognition failed. Soniox is unavailable.');
    expect(alert.closest('.capsule')).not.toBeNull();
    // No strip over the transcript.
    expect(container.querySelector('.transcript-layout')!.contains(alert)).toBe(false);
  });

  it('shows the logo for a stopped session that never recorded, and stops polling', async () => {
    vi.useFakeTimers();
    words = null;
    useStore.setState({ recorderState: 'idle' });
    render(<TranscriptView focusSegmentId={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByText('Record or open a session to see its transcript here.')).toBeInTheDocument();
    expect(screen.queryByText('Recording — waiting for first words')).not.toBeInTheDocument();
    const reads = eventReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(eventReads()).toBe(reads);
  });

  it('keeps shown text on a failed read and offers Retry in the recorder, which reloads', async () => {
    vi.useFakeTimers();
    render(withRecorder());
    await act(async () => {});
    expect(screen.getByText('Confirmed text.')).toBeInTheDocument();
    failReads = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not refresh the transcript/);
    expect(screen.getByRole('alert').closest('.capsule')).not.toBeNull();
    expect(screen.getByText('Confirmed text.')).toBeInTheDocument();
    failReads = false;
    words = ['Confirmed text.', ' More.'];
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(screen.queryByText(/Could not refresh the transcript/)).not.toBeInTheDocument();
    expect(screen.getByText(/More\./)).toBeInTheDocument();
  });

  it('does not install a delayed page after switching sessions', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = window.skaz.request;
    window.skaz.request = vi.fn(async (req: BridgeRequest) => {
      if (req.path === '/sessions/archive') return { ok: true, status: 200, data: {
        session: { id: 'archive', title: 'Archive', mode: 'legacy', status: 'stopped', duration_ms: 0, created_at: '' },
        segments: [], messages: [], notes: null } } as never;
      if (req.path === '/sessions/archive/live/events') return { ok: false, status: 404, detail: 'Not found' } as never;
      if (req.path === '/sessions/native/live/events') await gate;
      return original(req);
    }) as typeof original;
    useStore.setState({ recorderState: 'idle' });
    render(<TranscriptView focusSegmentId={null} />);
    await act(async () => { await useStore.getState().selectSession('archive'); });
    await act(async () => { release(); });
    expect(screen.queryByText('Confirmed text.')).not.toBeInTheDocument();
  });
});
