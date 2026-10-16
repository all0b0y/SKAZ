import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocalModelsBrowser } from './LocalModelsBrowser';
import { useStore } from '../../state/store';
import { ApiError } from '../../api/client';
import type { LocalModelState, LocalModelStatus, ModelInfo } from '../../api/types';

// Contract: .runtime/asr-local-contract.md. GET status is safe to run on
// mount/selection; this UI must fire POST prepare ONLY from an explicit click.
// The backend's separate environment opt-in is unchanged.
describe('LocalModelsBrowser', () => {
  const localCatalog: ModelInfo[] = [
    { id: 'small', name: 'Whisper Small', input_modalities: ['audio'], output_modalities: ['text'], verified: true },
    { id: 'tiny', name: 'Whisper Tiny', input_modalities: ['audio'], output_modalities: ['text'], verified: true },
  ];

  const localStatus = (overrides: Partial<LocalModelStatus> = {}): LocalModelStatus => ({
    model: 'small',
    state: 'not_installed',
    error: null,
    ...overrides,
  });

  beforeEach(() => {
    useStore.setState({
      loadModels: vi.fn(async (provider: string) =>
        provider === 'local-gigachat-mlx'
          ? [{
              id: 'ai-babai/gigachat-audio-mlx',
              name: 'GigaChat Audio MLX (BF16)',
              input_modalities: ['audio'],
              output_modalities: ['text'],
              asr_contract: 'legacy' as const,
              verified: false,
              note: 'Local audio-language model; chunk timing only; contextual finality requires local-whisper.',
            }]
          : localCatalog,
      ),
      deleteLocalModel: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Every known checkpoint is a collapsed row; a test expands the one it needs. */
  const expandRow = async (user: ReturnType<typeof userEvent.setup>, name: RegExp | string) => {
    await user.click(await screen.findByRole('button', { name }));
  };

  it('lists every known checkpoint for both local providers, installed or not', async () => {
    useStore.setState({ localModelStatus: vi.fn(async () => localStatus()) });
    render(<LocalModelsBrowser />);

    expect(await screen.findByText('Whisper Small')).toBeInTheDocument();
    expect(screen.getByText('Whisper Tiny')).toBeInTheDocument();
    expect(screen.getByText('GigaChat Audio MLX (BF16)')).toBeInTheDocument();
    expect(screen.getByText('Local Whisper')).toBeInTheDocument();
    expect(screen.getByText('GigaChat (local)')).toBeInTheDocument();
  });

  it('offers the exact GigaChat MLX checkpoint without an API key and explains its limits', async () => {
    const localModelStatus = vi.fn(async () => localStatus({
      provider: 'local-gigachat-mlx',
      model: 'ai-babai/gigachat-audio-mlx',
      state: 'unsupported',
      error: 'The BF16 artifact needs more physical memory than this Mac has.',
      hardware: {
        physical_memory_bytes: 17_179_869_184,
        required_memory_bytes: 29_538_701_764,
      },
    }));
    useStore.setState({ localModelStatus });
    const user = userEvent.setup();
    render(<LocalModelsBrowser />);

    await expandRow(user, /GigaChat Audio MLX/);

    expect(await screen.findByText(/bf16 artifact needs more physical memory/i)).toBeInTheDocument();
    expect(screen.getByText(/chunk timing only/i)).toBeInTheDocument();
    expect(screen.getByText(/contextual finality requires local-whisper/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(localModelStatus).toHaveBeenCalledWith('local-gigachat-mlx', 'ai-babai/gigachat-audio-mlx');
  });

  it('shows real byte/file progress labels without inventing a percentage', async () => {
    const localModelStatus = vi.fn(async () => localStatus({
      state: 'installing',
      progress: {
        stage: 'downloading',
        downloaded_bytes: 1_048_576,
        completed_files: 2,
        total_bytes: null,
        total_files: null,
      },
    }));
    useStore.setState({ localModelStatus });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    expect(await screen.findByText(/1\.0 mib downloaded/i)).toBeInTheDocument();
    expect(screen.getByText(/2 files completed/i)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('requires UI confirmation before deletion and refreshes status after success', async () => {
    const localModelStatus = vi.fn(async () => localStatus({
      state: 'ready',
      cached: true,
      shared_cache: true,
    }));
    const deleteLocalModel = vi.fn(async () => localStatus({ state: 'not_installed' }));
    useStore.setState({ localModelStatus, deleteLocalModel });
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    const remove = await screen.findByRole('button', { name: /delete downloaded model/i });
    await user.click(remove);
    expect(deleteLocalModel).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/shared hugging face cache/i));
    expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/other applications/i));
    await user.click(remove);

    expect(deleteLocalModel).toHaveBeenCalledWith('local-whisper', 'small');
    expect(await screen.findByRole('button', { name: /download model/i })).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('checks status via GET on expand for a known local checkpoint and never calls prepare on its own', async () => {
    const localModelStatus = vi.fn(async () => localStatus());
    const prepareLocalModel = vi.fn();
    useStore.setState({ localModelStatus, prepareLocalModel });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    await waitFor(() => expect(localModelStatus).toHaveBeenCalledWith('local-whisper', 'small'));
    expect(await screen.findByRole('button', { name: /download/i })).toBeInTheDocument();
    expect(prepareLocalModel).not.toHaveBeenCalled();
  });

  it('fires prepare only on an explicit click', async () => {
    const localModelStatus = vi.fn(async () => localStatus());
    const prepareLocalModel = vi.fn(async () => localStatus({ state: 'loading' }));
    useStore.setState({ localModelStatus, prepareLocalModel });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    const button = await screen.findByRole('button', { name: /download/i });
    expect(prepareLocalModel).not.toHaveBeenCalled();
    await user.click(button);
    expect(prepareLocalModel).toHaveBeenCalledWith('local-whisper', 'small');
    expect(prepareLocalModel).toHaveBeenCalledTimes(1);
  });

  it('disables duplicate prepare actions while the explicit POST is pending', async () => {
    let resolvePrepare: ((status: LocalModelStatus) => void) | undefined;
    const localModelStatus = vi.fn(async () => localStatus());
    const prepareLocalModel = vi.fn(
      () => new Promise<LocalModelStatus>((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    useStore.setState({ localModelStatus, prepareLocalModel });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    const button = await screen.findByRole('button', { name: /download model/i });
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(prepareLocalModel).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePrepare?.(localStatus({ state: 'installing' }));
      await Promise.resolve();
    });
  });

  it('discards a stale prepare reply after collapsing and re-expanding a different checkpoint', async () => {
    let resolveSmallPrepare: ((status: LocalModelStatus) => void) | undefined;
    const localModelStatus = vi.fn(async (_provider: string, model: string) =>
      localStatus({ model, state: 'not_installed' }),
    );
    const prepareLocalModel = vi.fn(
      (_provider: string, model: string) => new Promise<LocalModelStatus>((resolve) => {
        if (model === 'small') resolveSmallPrepare = resolve;
      }),
    );
    useStore.setState({ localModelStatus, prepareLocalModel });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');
    await user.click(await screen.findByRole('button', { name: /download model/i }));

    // Collapse "small" and expand "tiny" — a different checkpoint's panel unmounts the old one.
    await user.click(screen.getByRole('button', { name: 'Whisper Small' }));
    await expandRow(user, 'Whisper Tiny');
    await waitFor(() => expect(localModelStatus).toHaveBeenCalledWith('local-whisper', 'tiny'));
    expect(await screen.findByRole('button', { name: /download model/i })).toBeEnabled();

    await act(async () => {
      resolveSmallPrepare?.(localStatus({ model: 'small', state: 'ready' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByText(/engine loads locally/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /download model/i })).toBeEnabled();
  });

  it('shows a distinct dependency_missing message and never offers the download button as its remedy', async () => {
    const localModelStatus = vi.fn(async () =>
      localStatus({ state: 'dependency_missing', error: 'The local ASR backend extra is not installed.' }),
    );
    const prepareLocalModel = vi.fn();
    useStore.setState({ localModelStatus, prepareLocalModel });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    expect(await screen.findByText(/local asr backend extra is not installed/i)).toBeInTheDocument();
    expect(screen.getByText(/installing the backend/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
    expect(prepareLocalModel).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported', 'The BF16 artifact needs more physical memory than this Mac has.'],
    ['dependency_missing', 'The local ASR backend extra is not installed.'],
  ] as const)('can delete cached artifacts while the model state is %s', async (state, error) => {
    const localModelStatus = vi.fn(async () => localStatus({ state, error, cached: true }));
    const deleteLocalModel = vi.fn(async () => localStatus({ state, error, cached: false }));
    useStore.setState({ localModelStatus, deleteLocalModel, prepareLocalModel: vi.fn() });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    await user.click(await screen.findByRole('button', { name: /delete cached model files/i }));
    expect(deleteLocalModel).toHaveBeenCalledWith('local-whisper', 'small');
    await waitFor(() => expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it('describes ready as the engine loading locally, never as a quality guarantee', async () => {
    const localModelStatus = vi.fn(async () => localStatus({ state: 'ready', error: null }));
    useStore.setState({ localModelStatus, prepareLocalModel: vi.fn() });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    expect(await screen.findByText(/engine loads locally/i)).toBeInTheDocument();
    expect(screen.queryByText(/quality/i)).not.toBeInTheDocument();
  });

  it('polls status on an interval while loading, shows an indeterminate indicator with no percentage, and stops on unmount', async () => {
    const localModelStatus = vi.fn(async () => localStatus({ state: 'loading' }));
    useStore.setState({ localModelStatus, prepareLocalModel: vi.fn() });
    const { unmount } = render(<LocalModelsBrowser />);
    const row = await screen.findByRole('button', { name: 'Whisper Small' });

    // Install the clock before expansion schedules the first polling timer.
    vi.useFakeTimers();
    try {
      fireEvent.click(row);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(localModelStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/preparing/i)).toBeInTheDocument();
      expect(screen.queryByText(/%/)).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(localModelStatus).toHaveBeenCalledTimes(2);

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(localModelStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the backend 409 conflict message without crashing', async () => {
    const localModelStatus = vi.fn(async () => localStatus());
    const prepareLocalModel = vi.fn(async () => {
      throw new ApiError(409, "'tiny' is being prepared right now; wait for it to finish.");
    });
    useStore.setState({ localModelStatus, prepareLocalModel });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    await user.click(await screen.findByRole('button', { name: /download/i }));
    expect(await screen.findByText(/being prepared right now/i)).toBeInTheDocument();
  });

  it('shows the backend 400 unknown-id status message without crashing', async () => {
    const localModelStatus = vi.fn(async () => {
      throw new ApiError(400, 'Unknown local model. Known local checkpoints: tiny, small.');
    });
    useStore.setState({ localModelStatus, prepareLocalModel: vi.fn() });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    expect(await screen.findByText(/unknown local model/i)).toBeInTheDocument();
  });

  it('treats an unrecognised future state as not ready for use', async () => {
    const localModelStatus = vi.fn(async () => ({
      model: 'small',
      state: 'downloading_extra_fast' as unknown as LocalModelState,
      error: null,
    }));
    useStore.setState({ localModelStatus, prepareLocalModel: vi.fn() });
    const user = userEvent.setup();

    render(<LocalModelsBrowser />);
    await expandRow(user, 'Whisper Small');

    expect(await screen.findByText(/not ready/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/engine loads locally/i)).not.toBeInTheDocument();
  });
});
