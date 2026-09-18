import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecorderBar } from './RecorderBar';
import { useStore } from '../../state/store';
import type { UploadQueueState } from '../../audio/uploadQueue';
import { idleMeterSnapshot } from '../../audio/meter';

const queue = (over: Partial<UploadQueueState> = {}): UploadQueueState => ({
  pending: 0,
  inFlight: null,
  completed: 0,
  duplicates: 0,
  failed: [],
  droppedCount: 0,
  overflow: false,
  lastError: null,
  ...over,
});

beforeEach(() => {
  useStore.setState({
    recorderState: 'idle',
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
    settings: null,
    languageMarks: [],
    devices: [],
    selectedDeviceId: null,
    changeTranscriptLanguage: vi.fn(async () => undefined),
  });
});

describe('RecorderBar', () => {
  it('offers continuation, not a new Record action, for a reopened recording', async () => {
    const resume = vi.fn();
    useStore.setState({
      activeSessionId: 'recorded', recorderState: 'stopped', resumeRecording: resume,
      sessions: [{ id: 'recorded', title: 'Recorded', created_at: '', status: 'stopped', duration_ms: 1000, mode: 'legacy' }],
    });
    render(<RecorderBar />);
    expect(screen.queryByRole('button', { name: 'Record' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue recording' }));
    expect(resume).toHaveBeenCalledOnce();
  });
  it('disables Record when the chosen contextual mode is not capable', () => {
    useStore.setState({
      nextRecordingMode: 'contextual_local',
      liveCapabilities: {
        mode: 'contextual_local', capable: false,
        requirements: { local_profile_selected: true, contextual_local_enabled: false, live_finality_enabled: false, local_speech_gate_enabled: false },
        detail: 'Enable both experimental flags.',
      },
    });
    render(<RecorderBar />);
    expect(screen.getByRole('button', { name: /record/i })).toBeDisabled();
  });

  it('shows Record when idle and Pause/Stop while recording', () => {
    useStore.setState({ recorderState: 'idle' });
    const { rerender } = render(<RecorderBar />);
    expect(screen.getByRole('button', { name: /Record/ })).toBeInTheDocument();

    // Store update into the mounted component must run inside act().
    act(() => useStore.setState({ recorderState: 'recording' }));
    rerender(<RecorderBar />);
    expect(screen.getByRole('button', { name: /Pause/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument();
  });

  it('keeps routine local saving silent', () => {
    useStore.setState({ recorderState: 'recording', queue: queue({ pending: 3 }) });
    render(<RecorderBar />);
    expect(screen.queryByText(/Saving locally|3 pending/)).not.toBeInTheDocument();
    expect(document.querySelector('.recorder__feed')).not.toBeInTheDocument();
  });

  it('surfaces protected backpressure without claiming audio was dropped', () => {
    useStore.setState({
      queue: queue({
        overflow: true,
        droppedCount: 0,
        failed: [{ sequence: 2, error: 'Audio protected; recording paused', attempts: 0 }],
      }),
    });
    render(<RecorderBar />);
    expect(screen.getByText(/Capture stopped.*buffered audio retained/i)).toBeInTheDocument();
    expect(screen.queryByText(/dropped/i)).not.toBeInTheDocument();
  });

  it('disables record and new capture actions while audio is draining', () => {
    useStore.setState({ recorderState: 'processing', queue: queue({ pending: 2 }) });
    render(<RecorderBar />);
    expect(screen.getByRole('button', { name: /Processing/i })).toBeDisabled();
  });

  it('shows failed uploads with a working retry action, rendered above the panel as a status layer', async () => {
    const retry = vi.fn();
    useStore.setState({
      queue: queue({ failed: [{ sequence: 1, error: 'boom', attempts: 4 }] }),
      retryFailedUploads: retry,
    });
    const user = userEvent.setup();
    render(<RecorderBar />);
    const feedLayer = document.querySelector('.recorder__feed-layer');
    expect(feedLayer).toContainElement(screen.getByText(/1 local save failed/));
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(retry).toHaveBeenCalled();
  });

  it('separates saved audio from incomplete transcription and retries ASR explicitly', async () => {
    const retryTranscription = vi.fn();
    useStore.setState({
      transcription: {
        pending: 0,
        inFlight: null,
        completed: 0,
        failed: [{ sessionId: 's1', sequence: 2, startMs: 0, endMs: 10, error: 'provider failed' }],
        deferred: 3,
        diskFailed: 1,
        blockedByConsent: false,
        lastError: 'provider failed',
      },
      retryFailedTranscriptions: retryTranscription,
    });
    const user = userEvent.setup();
    render(<RecorderBar />);
    expect(screen.getByText(/Audio saved.*2 transcription requests failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Transcription.*3 pending/i)).toBeInTheDocument();
    expect(screen.queryByText(/audio lost/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry transcription/i }));
    expect(retryTranscription).toHaveBeenCalledTimes(1);
  });

  it('renders a recording error message for the operator', () => {
    useStore.setState({ recorderError: 'Microphone disconnected' });
    render(<RecorderBar />);
    expect(screen.getByRole('alert')).toHaveTextContent('Microphone disconnected');
  });

  it('offers an explicit status-only retry after backend lifecycle acknowledgement fails', async () => {
    const retryStatus = vi.fn();
    useStore.setState({
      recorderState: 'stopped',
      recorderError: 'Backend stop confirmation failed',
      pendingSessionStatus: 'stopped',
      pendingSessionStatusSessionId: 'session-a',
      retrySessionStatus: retryStatus,
    });
    const user = userEvent.setup();

    render(<RecorderBar />);
    await user.click(screen.getByRole('button', { name: /retry stop confirmation/i }));

    expect(retryStatus).toHaveBeenCalledTimes(1);
  });

  it('shows real peak risk, sustained-quiet, and honest VAD availability as badges, and keeps the exact dBFS reading in the ring label instead of on the page', () => {
    useStore.setState({
      recorderState: 'recording',
      meter: {
        dbfs: -20,
        peakDbfs: -0.05,
        clipping: true,
        sustainedLow: true,
        vad: 'unavailable',
      },
    });
    render(<RecorderBar />);

    // Nothing prints the raw number to the page anymore...
    expect(screen.queryByText('-20 dBFS')).not.toBeInTheDocument();
    // ...but it's still there for assistive tech and on hover.
    const ring = screen.getByRole('img', { name: /Input level -20 dBFS; peak 0 dBFS/i });
    expect(ring).toHaveAttribute('title', '-20 dBFS');

    expect(screen.getByText(/Clipping risk/i)).toBeInTheDocument();
    expect(screen.getByText(/We can barely hear you/i)).toBeInTheDocument();
    expect(screen.getByText(/Speech detection unavailable/i)).toBeInTheDocument();
  });

  it.each(['idle', 'recording', 'paused'] as const)('does not offer obsolete RU/EN fragment switches when %s', (recorderState) => {
    useStore.setState({ recorderState });
    render(<RecorderBar />);
    expect(screen.queryByRole('button', { name: 'RU' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'EN' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Applies to new fragments/i)).not.toBeInTheDocument();
  });
});
