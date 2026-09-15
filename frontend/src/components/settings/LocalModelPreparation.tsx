import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { Icon } from '../ui/Icon';
import type { LocalModelStatus, LocalProviderName } from '../../api/types';

const POLL_INTERVAL_MS = 1000;

interface LocalModelPreparationProps {
  provider: LocalProviderName;
  model: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
};

export function LocalModelPreparation({ provider, model }: LocalModelPreparationProps) {
  const localModelStatus = useStore((s) => s.localModelStatus);
  const prepareLocalModel = useStore((s) => s.prepareLocalModel);
  const deleteLocalModel = useStore((s) => s.deleteLocalModel);
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    setStatus(null);
    setRequestError(null);
    setMutating(false);
    localModelStatus(provider, model)
      .then((next) => {
        if (generation.current !== requestGeneration) return;
        setStatus(next);
        setRequestError(null);
      })
      .catch((error: unknown) => {
        if (generation.current === requestGeneration) setRequestError(errorMessage(error));
      });
    return () => {
      generation.current += 1;
    };
  }, [provider, model, localModelStatus]);

  const state = status?.state;
  const inProgress = state === 'loading' || state === 'installing' || state === 'verifying';
  useEffect(() => {
    if (!inProgress) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      const requestGeneration = ++generation.current;
      try {
        const next = await localModelStatus(provider, model);
        if (!active || generation.current !== requestGeneration) return;
        setStatus(next);
        setRequestError(null);
      } catch (error) {
        if (active && generation.current === requestGeneration) {
          setRequestError(errorMessage(error));
        }
      } finally {
        if (active && generation.current === requestGeneration) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      }
    };

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [inProgress, provider, model, localModelStatus]);

  const runMutation = async (
    operation: (provider: LocalProviderName, model: string) => Promise<LocalModelStatus>,
  ) => {
    // A mutation is authoritative over any earlier GET/poll for the same
    // selection. Its version also lets a provider/model switch invalidate it.
    const requestGeneration = ++generation.current;
    setMutating(true);
    setRequestError(null);
    try {
      const next = await operation(provider, model);
      if (generation.current === requestGeneration) setStatus(next);
    } catch (error) {
      if (generation.current === requestGeneration) setRequestError(errorMessage(error));
    } finally {
      if (generation.current === requestGeneration) setMutating(false);
    }
  };

  const onDelete = () => {
    const sharedCacheConsequence = status?.shared_cache
      ? '\n\nThis removes the repository from the shared Hugging Face cache and may affect other applications that use it.'
      : '';
    if (!window.confirm(`Delete cached files for ${model}?${sharedCacheConsequence}`)) return;
    void runMutation(deleteLocalModel);
  };

  const known =
    state === 'not_installed' ||
    state === 'loading' ||
    state === 'installing' ||
    state === 'verifying' ||
    state === 'ready' ||
    state === 'error' ||
    state === 'dependency_missing' ||
    state === 'unsupported';
  const progress = status?.progress;
  const canDeleteCached = status?.cached === true && known && !inProgress;

  return (
    <div className="profile__local">
      {requestError && (
        <p className="profile__note profile__note--warn">
          <Icon name="warning" size={13} /> {requestError}
        </p>
      )}
      {status?.warning && <p className="profile__note profile__note--warn">{status.warning}</p>}

      {state === 'not_installed' && (
        <>
          <p className="profile__note">This model is not fully installed in the selected cache.</p>
          <button
            type="button"
            className="profile__download"
            onClick={() => void runMutation(prepareLocalModel)}
            disabled={mutating}
          >
            Download model
          </button>
        </>
      )}

      {inProgress && (
        <p className="profile__note" role="status" aria-live="polite">
          <span className="profile__spinner" aria-hidden="true" />
          {state === 'verifying' ? 'Verifying local files offline…' : 'Preparing the model…'}
          {progress && progress.downloaded_bytes > 0 && (
            <> {formatBytes(progress.downloaded_bytes)} downloaded.</>
          )}
          {progress && progress.completed_files > 0 && (
            <> {progress.completed_files} files completed.</>
          )}
        </p>
      )}

      {state === 'ready' && (
        <p className="profile__note profile__note--ok">
          <Icon name="check" size={13} /> Ready: the engine loads locally with the network closed. A real
          transcription is still required before trusting its output.
        </p>
      )}

      {state === 'dependency_missing' && (
        <>
          {status?.error && (
            <p className="profile__note profile__note--warn">
              <Icon name="warning" size={13} /> {status.error}
            </p>
          )}
          <p className="profile__note">
            Installing the backend extra for this provider is required before downloading.
          </p>
        </>
      )}

      {state === 'unsupported' && status?.error && (
        <p className="profile__note profile__note--warn">
          <Icon name="warning" size={13} /> {status.error}
        </p>
      )}

      {state === 'error' && (
        <>
          {status?.error && (
            <p className="profile__note profile__note--warn">
              <Icon name="warning" size={13} /> {status.error}
            </p>
          )}
          <button
            type="button"
            className="profile__download"
            onClick={() => void runMutation(prepareLocalModel)}
            disabled={mutating}
          >
            Retry download
          </button>
        </>
      )}

      {canDeleteCached && (
        <button type="button" className="profile__download" onClick={onDelete} disabled={mutating}>
          {state === 'ready'
            ? 'Delete downloaded model'
            : state === 'error'
              ? 'Delete partial model files'
              : 'Delete cached model files'}
        </button>
      )}

      {state !== undefined && !known && (
        <p className="profile__note profile__note--warn">
          <Icon name="warning" size={13} /> This model reports a state this version does not recognise; it is
          treated as not ready for use.
        </p>
      )}
    </div>
  );
}
