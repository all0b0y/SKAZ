/**
 * The recorder clock and level meter must not rebuild the whole RecorderBar
 * (ТЗ, Задача 6; docs/PERFORMANCE-PLAN.md Срез 2). `elapsedMs` ticks every
 * 250ms while recording and `meter` reports up to 10x/second; before this
 * split both were read at RecorderBar's top level, so every tick re-ran the
 * buttons, feed alerts, and progress bar along with the clock digits.
 *
 * This measures the seam directly: mutate only `elapsedMs` / `meter` and
 * count how often RecorderBar's own body (not its clock/meter subcomponents)
 * re-runs, via a render-count spy on Button, which lives outside both split
 * subscriptions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { RecorderBar } from './RecorderBar';
import { useStore } from '../../state/store';
import { idleMeterSnapshot } from '../../audio/meter';
import * as ButtonModule from '../ui/Button';
import type { UploadQueueState } from '../../audio/uploadQueue';

const queue = (): UploadQueueState => ({
  pending: 0, inFlight: null, completed: 0, duplicates: 0, failed: [],
  droppedCount: 0, overflow: false, lastError: null,
});

beforeEach(() => {
  useStore.setState({
    recorderState: 'recording',
    elapsedMs: 0,
    level: 0,
    meter: idleMeterSnapshot(),
    queue: queue(),
    transcription: {
      pending: 0, inFlight: null, completed: 0, failed: [], deferred: 0,
      diskFailed: 0, blockedByConsent: false, lastError: null,
    },
    detail: null,
    sessions: [],
    activeSessionId: null,
    recorderError: null,
    pendingSessionStatus: null,
    pendingSessionStatusSessionId: null,
    nextRecordingMode: 'legacy',
    liveCapabilities: null,
  } as never);
});

describe('RecorderBar isolation from the clock and meter ticks', () => {
  it('does not re-render the controls/feed body when only elapsedMs changes', () => {
    const buttonRenders = vi.spyOn(ButtonModule, 'Button');
    render(<RecorderBar />);
    const before = buttonRenders.mock.calls.length;

    // 4 ticks — one second of the real 250ms clock interval.
    for (let i = 1; i <= 4; i += 1) {
      act(() => { useStore.setState({ elapsedMs: i * 250 } as never); });
    }
    expect(buttonRenders.mock.calls.length - before).toBe(0);
    // The clock itself still updates.
    expect(screen.getByText('00:01')).toBeInTheDocument();
  });

  it('does not re-render the controls/feed body when only meter changes', () => {
    const buttonRenders = vi.spyOn(ButtonModule, 'Button');
    render(<RecorderBar />);
    const before = buttonRenders.mock.calls.length;

    // 10 reports — one second of the real meter cadence.
    for (let i = 0; i < 10; i += 1) {
      act(() => {
        useStore.setState({
          meter: { dbfs: -20 - i, peakDbfs: -1, clipping: false, sustainedLow: false, vad: 'unavailable' },
        } as never);
      });
    }
    expect(buttonRenders.mock.calls.length - before).toBe(0);
  });
});
