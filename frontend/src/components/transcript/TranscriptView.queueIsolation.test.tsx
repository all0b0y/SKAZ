/**
 * Audio-queue events must not rebuild the transcript (ТЗ, Задача 2).
 *
 * Capture emits a chunk every 100 ms and PersistenceQueue reports state
 * several times per chunk, so `store.queue` changes roughly 40x/second. The
 * transcript subscribes to that store. If saving audio re-renders the
 * transcript, a 60-minute recording pays its full projection cost 40 times a
 * second on top of the one-second poll (docs/BASELINE-PROFILE.md).
 *
 * This measures the seam directly: mutate only queue state and count how often
 * the transcript's own projection work runs.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptView } from './TranscriptView';
import { useStore } from '../../state/store';
import * as monologues from './NativeMonologues';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const SAMPLE_RATE = 16_000;
const SESSION = 'perf-session';

function nativeSnapshot() {
  return {
    session_id: SESSION,
    sample_rate: SAMPLE_RATE,
    saved_samples: SAMPLE_RATE,
    next_sequence: 1,
    transcription: 'streaming',
    recording_mode: 'transcription',
    final_tokens: [{
      id: 'tok-1', connection_id: 'c1', segment_id: 'seg-1', text: 'Подтверждённый текст.',
      speaker_number: 1, start_sample: 0, end_sample: SAMPLE_RATE,
    }],
    speakers: [], connections: [], gaps: [],
  };
}

describe('TranscriptView isolation from audio-queue events', () => {
  let restore: typeof window.audiohelper.request;

  beforeEach(() => {
    restore = window.audiohelper.request;
    window.audiohelper.request = (async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      if (req.path === `/sessions/${SESSION}/live`) {
        return { ok: true, status: 200, data: nativeSnapshot() as T };
      }
      if (req.path === `/sessions/${SESSION}`) {
        return {
          ok: true, status: 200,
          data: { id: SESSION, title: 'perf', segments: [{
            id: 'seg-1', session_id: SESSION, sequence: 0, start_ms: 0, end_ms: 1000,
            text: 'Подтверждённый текст.', language: 'ru',
          }], notes_list: [] } as T,
        };
      }
      return { ok: true, status: 200, data: {} as T };
    }) as typeof window.audiohelper.request;
    useStore.setState({
      activeSessionId: SESSION,
      sessions: [{ id: SESSION, title: 'perf', mode: 'native', duration_ms: 1000 }],
      recorderState: 'recording',
      detail: null,
      queue: { pending: 0, inFlight: null, completed: 0, duplicates: 0, failed: [], droppedCount: 0, overflow: false, lastError: null },
    } as never);
  });

  afterEach(() => {
    window.audiohelper.request = restore;
    vi.restoreAllMocks();
  });

  it('does not re-project the transcript when only audio-queue state changes', async () => {
    const projected = vi.spyOn(monologues, 'NativeMonologues');
    render(<TranscriptView focusSegmentId={null} />);
    await screen.findByText('Подтверждённый текст.');
    await waitFor(() => expect(projected.mock.calls.length).toBeGreaterThan(0));

    const before = projected.mock.calls.length;
    // 40 queue reports — one second of capture at the real cadence. No new
    // transcript data arrives, only audio-save bookkeeping.
    for (let i = 0; i < 40; i += 1) {
      act(() => {
        useStore.setState({
          queue: {
            pending: i % 3, inFlight: i, completed: i, duplicates: 0,
            failed: [], droppedCount: 0, overflow: false, lastError: null,
          },
        } as never);
      });
    }
    expect(projected.mock.calls.length - before).toBe(0);
  });

  it('does not re-project the transcript when a durable audio save marks notes stale', async () => {
    // Every persisted chunk (10/second) rebuilds `detail` to flag notes stale.
    // That object identity change must not reach the transcript: its segments
    // are untouched.
    const projected = vi.spyOn(monologues, 'NativeMonologues');
    render(<TranscriptView focusSegmentId={null} />);
    await screen.findByText('Подтверждённый текст.');
    await waitFor(() => expect(projected.mock.calls.length).toBeGreaterThan(0));

    const before = projected.mock.calls.length;
    for (let i = 0; i < 10; i += 1) {
      act(() => {
        const state = useStore.getState();
        useStore.setState({
          detail: {
            ...state.detail!,
            notes: null,
            notes_list: [{ id: `n${i}`, title: 'note', stale: true }],
          },
        } as never);
      });
    }
    expect(projected.mock.calls.length - before).toBe(0);
  });
});
