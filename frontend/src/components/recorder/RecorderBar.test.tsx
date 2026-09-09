import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecorderBar } from './RecorderBar';
import { useStore } from '../../state/store';
import type { UploadQueueState } from '../../audio/uploadQueue';

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
    queue: queue(),
    recorderError: null,
    devices: [],
    selectedDeviceId: null,
    // RecorderBar enumerates devices on mount; stub it so that unrelated async
    // store update does not fire outside act() during these UI unit tests.
    enumerateDevices: vi.fn(async () => undefined),
  });
});

describe('RecorderBar', () => {
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

  it('surfaces the pending upload count', () => {
    useStore.setState({ recorderState: 'recording', queue: queue({ pending: 3 }) });
    render(<RecorderBar />);
    expect(screen.getByText(/3 pending/)).toBeInTheDocument();
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
    expect(screen.getByText(/Recording paused.*audio protected/i)).toBeInTheDocument();
    expect(screen.queryByText(/dropped/i)).not.toBeInTheDocument();
  });

  it('disables record and new capture actions while audio is draining', () => {
    useStore.setState({ recorderState: 'processing', queue: queue({ pending: 2 }) });
    render(<RecorderBar />);
    expect(screen.getByRole('button', { name: /Processing/i })).toBeDisabled();
  });

  it('shows failed uploads with a working retry action', async () => {
    const retry = vi.fn();
    useStore.setState({
      queue: queue({ failed: [{ sequence: 1, error: 'boom', attempts: 4 }] }),
      retryFailedUploads: retry,
    });
    const user = userEvent.setup();
    render(<RecorderBar />);
    expect(screen.getByText(/1 upload failed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(retry).toHaveBeenCalled();
  });

  it('renders a recording error message for the operator', () => {
    useStore.setState({ recorderError: 'Microphone disconnected' });
    render(<RecorderBar />);
    expect(screen.getByRole('alert')).toHaveTextContent('Microphone disconnected');
  });
});
