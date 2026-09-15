import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalModelStatus, LocalProviderName } from '../../api/types';
import { useStore } from '../../state/store';
import { LocalModelPreparation } from './LocalModelPreparation';

const status = (
  provider: LocalProviderName,
  model: string,
  state: LocalModelStatus['state'] = 'not_installed',
): LocalModelStatus => ({ provider, model, state, error: null, cached: false, shared_cache: false });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe('LocalModelPreparation request ordering', () => {
  beforeEach(() => {
    useStore.setState({
      localModelStatus: vi.fn(async (provider, model) => status(provider, model)),
      prepareLocalModel: vi.fn(async (provider, model) => status(provider, model, 'installing')),
      deleteLocalModel: vi.fn(async (provider, model) => status(provider, model)),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enables a newly selected model while an old preparation is pending and ignores its result', async () => {
    const oldPreparation = deferred<LocalModelStatus>();
    const prepareLocalModel = vi.fn((_provider: LocalProviderName, _model: string) => oldPreparation.promise);
    useStore.setState({ prepareLocalModel });
    const user = userEvent.setup();
    const view = render(<LocalModelPreparation provider="local-whisper" model="small" />);

    await user.click(await screen.findByRole('button', { name: /download model/i }));
    expect(screen.getByRole('button', { name: /download model/i })).toBeDisabled();

    view.rerender(<LocalModelPreparation provider="local-whisper" model="tiny" />);
    expect(await screen.findByRole('button', { name: /download model/i })).toBeEnabled();

    await act(async () => {
      oldPreparation.resolve(status('local-whisper', 'small', 'ready'));
      await oldPreparation.promise;
    });

    expect(screen.queryByText(/engine loads locally/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download model/i })).toBeEnabled();
  });

  it('ignores an old mutation error after switching providers and leaves the new selection enabled', async () => {
    const oldPreparation = deferred<LocalModelStatus>();
    useStore.setState({
      prepareLocalModel: vi.fn((_provider: LocalProviderName, _model: string) => oldPreparation.promise),
    });
    const user = userEvent.setup();
    const view = render(<LocalModelPreparation provider="local-whisper" model="small" />);

    await user.click(await screen.findByRole('button', { name: /download model/i }));
    view.rerender(
      <LocalModelPreparation provider="local-gigachat-mlx" model="ai-babai/gigachat-audio-mlx" />,
    );
    expect(await screen.findByRole('button', { name: /download model/i })).toBeEnabled();

    await act(async () => {
      oldPreparation.reject(new Error('stale preparation error'));
      try {
        await oldPreparation.promise;
      } catch {
        // The component handles the rejected operation; await it only to flush React state work.
      }
    });

    expect(screen.queryByText(/stale preparation error/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download model/i })).toBeEnabled();
  });

  it('ignores a stale initial status reply after the selection changes', async () => {
    const requests = new Map<string, Deferred<LocalModelStatus>>();
    const localModelStatus = vi.fn((provider: LocalProviderName, model: string) => {
      const request = deferred<LocalModelStatus>();
      requests.set(`${provider}:${model}`, request);
      return request.promise;
    });
    useStore.setState({ localModelStatus });
    const view = render(<LocalModelPreparation provider="local-whisper" model="small" />);

    await waitFor(() => expect(requests.has('local-whisper:small')).toBe(true));
    view.rerender(<LocalModelPreparation provider="local-whisper" model="tiny" />);
    await waitFor(() => expect(requests.has('local-whisper:tiny')).toBe(true));

    await act(async () => {
      requests.get('local-whisper:tiny')?.resolve(status('local-whisper', 'tiny'));
    });
    expect(await screen.findByRole('button', { name: /download model/i })).toBeEnabled();

    await act(async () => {
      requests.get('local-whisper:small')?.resolve(status('local-whisper', 'small', 'ready'));
    });
    expect(screen.queryByText(/engine loads locally/i)).not.toBeInTheDocument();
  });

  it('ignores a stale poll reply after the selection changes', async () => {
    vi.useFakeTimers();
    const oldPoll = deferred<LocalModelStatus>();
    let smallCalls = 0;
    const localModelStatus = vi.fn((provider: LocalProviderName, model: string) => {
      if (model === 'small') {
        smallCalls += 1;
        return smallCalls === 1
          ? Promise.resolve(status(provider, model, 'loading'))
          : oldPoll.promise;
      }
      return Promise.resolve(status(provider, model));
    });
    useStore.setState({ localModelStatus });
    const view = render(<LocalModelPreparation provider="local-whisper" model="small" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('status')).toHaveTextContent(/preparing/i);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(smallCalls).toBe(2);

    view.rerender(<LocalModelPreparation provider="local-whisper" model="tiny" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('button', { name: /download model/i })).toBeEnabled();

    await act(async () => {
      oldPoll.resolve(status('local-whisper', 'small', 'ready'));
      await oldPoll.promise;
    });
    expect(screen.queryByText(/engine loads locally/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download model/i })).toBeEnabled();
  });
});
