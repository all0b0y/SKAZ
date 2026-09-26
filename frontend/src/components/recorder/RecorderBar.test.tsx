import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecorderBar } from './RecorderBar';
import { useStore } from '../../state/store';
import type { UploadQueueState } from '../../audio/uploadQueue';
import { idleMeterSnapshot } from '../../audio/meter';
import { OPEN_SETTINGS_EVENT } from '../../lib/openSettings';
import type { Settings } from '../../api/types';

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
    meter: idleMeterSnapshot(),
    queue: queue(),
    transcription: {
      pending: 0, inFlight: null, completed: 0, failed: [], deferred: 0,
      diskFailed: 0, blockedByConsent: false, lastError: null,
    },
    finishing: false,
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
  it('shows the same warning again after a fresh attempt, with Record still enabled', async () => {
    useStore.setState({ recorderError: 'Transcription failed. Try again.' });
    render(<RecorderBar />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => useStore.setState({ recorderState: 'processing', recorderError: null }));
    act(() => useStore.setState({ recorderState: 'idle', recorderError: 'Transcription failed. Try again.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Transcription failed');
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
  });

  it('explains imported sessions and blocks microphone continuation', async () => {
    const resume = vi.fn();
    useStore.setState({
      activeSessionId: 'imported', recorderState: 'stopped', resumeRecording: resume,
      sessions: [{ id: 'imported', title: 'Imported', created_at: '', status: 'stopped', duration_ms: 1000, mode: 'legacy', origin: 'import' }],
    });
    render(<RecorderBar />);
    expect(screen.getByRole('button', { name: 'Continue recording' })).toBeDisabled();
    expect(screen.getByText('This session was created from an audio file. Create a new session to record from the microphone.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Continue recording' }));
    expect(resume).not.toHaveBeenCalled();
  });
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
    expect(screen.getByRole('button', { name: /^record$/i })).toBeDisabled();
  });

  it('shows Record when idle and Pause/Stop while recording', () => {
    useStore.setState({ recorderState: 'idle' });
    const { rerender } = render(<RecorderBar />);
    expect(screen.getByRole('button', { name: /^Record$/ })).toBeInTheDocument();

    // Store update into the mounted component must run inside act().
    act(() => useStore.setState({ recorderState: 'recording' }));
    rerender(<RecorderBar />);
    expect(screen.getByRole('button', { name: /Pause/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument();
  });

  it('keeps routine saving and transcription queues silent: no status pills at all', () => {
    useStore.setState({
      recorderState: 'recording', queue: queue({ pending: 3 }),
      transcription: {
        pending: 2, inFlight: null, completed: 0, failed: [{ sessionId: 's1', sequence: 2, startMs: 0, endMs: 10, error: 'x' }],
        deferred: 3, diskFailed: 1, blockedByConsent: true, lastError: 'x',
      },
    });
    render(<RecorderBar />);
    expect(screen.queryByText(/Saving locally|pending|transcription request|cloud consent/i)).not.toBeInTheDocument();
    expect(document.querySelector('.recorder__feed, .pill')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces protected backpressure in the capsule without claiming audio was dropped', async () => {
    const retry = vi.fn();
    useStore.setState({
      retryFailedUploads: retry,
      queue: queue({
        overflow: true,
        droppedCount: 0,
        failed: [{ sequence: 2, error: 'Audio protected; recording paused', attempts: 0 }],
      }),
    });
    render(<RecorderBar />);
    const alert = screen.getByRole('alert');
    expect(document.querySelector('.capsule')).toContainElement(alert);
    expect(alert).toHaveTextContent(/Capture stopped.*buffered audio retained/i);
    expect(screen.queryByText(/dropped/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Retry saving/ }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('disables recording while a start/pause transition is in flight', () => {
    useStore.setState({ recorderState: 'processing', finishing: false, queue: queue({ pending: 2 }) });
    render(<RecorderBar />);
    expect(screen.getByRole('button', { name: /Processing/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Record$/ })).not.toBeInTheDocument();
  });

  it('shows Finishing transcript after Stop, blocks recording, then says Done and returns to idle', async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ recorderState: 'processing', finishing: true, elapsedMs: 5_000 });
      render(<RecorderBar />);
      expect(screen.getByText('Finishing transcript…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Finishing transcript…' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: /^Record$/ })).not.toBeInTheDocument();
      const progress = screen.getByRole('progressbar', { name: 'Transcription progress' });
      expect(progress).toHaveAttribute('data-indeterminate', 'true');
      expect(progress).not.toHaveAttribute('aria-valuenow');

      act(() => useStore.setState({ recorderState: 'stopped', finishing: false }));
      expect(screen.getByText('Done').closest('[role="status"]')).not.toBeNull();
      expect(screen.queryByText('Finishing transcript…')).not.toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1_500); });
      expect(screen.queryByText('Done')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Record$/ })).toBeEnabled();
    } finally { vi.useRealTimers(); }
  });

  it('does not claim Done when finishing ends with an error', () => {
    useStore.setState({ recorderState: 'processing', finishing: true });
    render(<RecorderBar />);
    act(() => useStore.setState({ recorderState: 'stopped', finishing: false, recorderError: 'Backend stop confirmation failed' }));
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Backend stop confirmation failed');
  });

  it('renders a recording error in the capsule, expands the full text and stays until dismissed', async () => {
    useStore.setState({ recorderError: 'Microphone disconnected. Captured audio was flushed.' });
    const user = userEvent.setup();
    render(<RecorderBar />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Microphone disconnected');
    expect(document.querySelector('.capsule')).toHaveClass('capsule--error');
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Microphone disconnected/ }));
    expect(alert.querySelector('.capsule__error-full')).toHaveTextContent('Captured audio was flushed.');
    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // A different error is shown again: dismissal applies to that message only.
    act(() => useStore.setState({ recorderError: 'Local audio transport failed.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Local audio transport failed.');
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

  it('marks clipping on the wave itself instead of a separate badge, and keeps the exact dBFS reading off the page', () => {
    useStore.setState({
      recorderState: 'recording',
      meter: {
        dbfs: -20,
        peakDbfs: -0.05,
        clipping: true,
      },
    });
    render(<RecorderBar />);

    expect(screen.queryByText('-20 dBFS')).not.toBeInTheDocument();
    const wave = screen.getByRole('img', { name: /Input level -20 dBFS; peak 0 dBFS; clipping risk/i });
    expect(wave).toHaveAttribute('title', '-20 dBFS · Clipping risk');
    expect(wave).toHaveAttribute('data-clip', 'true');
    expect(screen.queryByText(/We can barely hear you/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Speech detection unavailable/i)).not.toBeInTheDocument();
  });

  it('dims the wave and keeps the dot still while paused', () => {
    useStore.setState({ recorderState: 'paused' });
    render(<RecorderBar />);
    expect(document.querySelector('.capsule')).toHaveAttribute('data-state', 'paused');
    expect(screen.getByRole('img', { name: /Input level/ })).toHaveAttribute('data-active', 'false');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it.each(['idle', 'recording', 'paused'] as const)('does not offer obsolete RU/EN fragment switches when %s', (recorderState) => {
    useStore.setState({ recorderState });
    render(<RecorderBar />);
    expect(screen.queryByRole('button', { name: 'RU' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'EN' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Applies to new fragments/i)).not.toBeInTheDocument();
  });
});

const configured = (over: Partial<Settings> = {}): Settings => ({
  asr: { provider: 'openrouter', model: '' }, agent: { provider: 'openrouter', model: '' },
  notes: { provider: 'openrouter', model: '' }, transcript_language: 'auto', output_language: 'ru',
  cloud_consent: true, contextual_local_enabled: false, provider_has_api_key: { soniox: true }, used_languages: ['ru'], ...over,
});

describe('RecorderBar — transcription not connected', () => {
  it('blocks Record without a Soniox key and says why, with a way into API keys', async () => {
    const start = vi.fn();
    const opened: string[] = [];
    const onOpen = (event: Event) => opened.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    useStore.setState({ settings: configured({ provider_has_api_key: {} }), startRecording: start });
    render(<RecorderBar />);
    const record = screen.getByRole('button', { name: 'Record' });
    expect(record).toBeDisabled();
    expect(record).toHaveAccessibleDescription('No Soniox key');
    expect(screen.getByText(/Transcription is not set up — add a Soniox API key/)).toBeVisible();
    await userEvent.click(record);
    expect(start).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(opened).toEqual(['api-keys']);
    window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  });

  it('blocks Continue recording too when cloud processing is off', () => {
    useStore.setState({
      settings: configured({ cloud_consent: false }),
      activeSessionId: 'recorded', recorderState: 'stopped',
      sessions: [{ id: 'recorded', title: 'Recorded', created_at: '', status: 'stopped', duration_ms: 1000, mode: 'legacy' }],
    });
    render(<RecorderBar />);
    const resume = screen.getByRole('button', { name: 'Continue recording' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAccessibleDescription('Cloud processing is off');
    expect(screen.getByText(/cloud processing is off/)).toBeVisible();
  });

  it('enables Record and shows no notice once a key and consent are in place', () => {
    useStore.setState({ settings: configured() });
    render(<RecorderBar />);
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
    expect(screen.queryByText(/Transcription is not set up/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument();
  });

  it('accuses nothing while settings are still loading', () => {
    useStore.setState({ settings: null });
    render(<RecorderBar />);
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
    expect(screen.queryByText(/Transcription is not set up/)).not.toBeInTheDocument();
  });
});
