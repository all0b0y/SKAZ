import { useState } from 'react';
import { clsx } from 'clsx';
import { Icon } from '../ui/Icon';
import { TASK_LABELS } from './providers';
import type { CloudProviderName, TaskKind } from '../../api/types';

interface ProviderCredentialsProps {
  provider: CloudProviderName;
  /** Tasks currently (draft-aware) assigned to this provider; may be empty. */
  tasks: TaskKind[];
  /** Whether the backend already holds a key for this provider. */
  hasStoredKey: boolean;
  /** Pending key for this provider in the current draft ('' means "delete on save"). */
  draftKey: string | undefined;
  /** Records the pending key for this provider. */
  onChangeKey: (provider: CloudProviderName, value: string) => void;
}

// One card per cloud provider, always rendered. A key belongs to the provider,
// not to a task profile: it can be entered before any task is assigned, and it
// is stored once no matter how many tasks later use that provider.
export function ProviderCredentials({
  provider,
  tasks,
  hasStoredKey,
  draftKey,
  onChangeKey,
}: ProviderCredentialsProps) {
  const [showKey, setShowKey] = useState(false);

  const usage =
    tasks.length > 0
      ? `Used by ${tasks.map((t) => TASK_LABELS[t]).join(', ')}`
      : 'Not assigned to any task yet';
  // A typed draft wins over the stored flag; '' is an explicit pending removal.
  const effectivelyStored = draftKey === undefined ? hasStoredKey : draftKey.length > 0;

  return (
    <section className="profile provider-card">
      <header className="profile__head">
        <h4>{provider}</h4>
        <p>{usage}</p>
      </header>

      <div className="field">
        <label htmlFor={`provider-${provider}-key`}>API key</label>
        <input
          id={`provider-${provider}-key`}
          type={showKey ? 'text' : 'password'}
          autoComplete="off"
          placeholder={hasStoredKey ? '•••••••• stored' : 'Not set'}
          value={draftKey ?? ''}
          onChange={(e) => onChangeKey(provider, e.target.value)}
        />
        <button type="button" className="field__toggle" onClick={() => setShowKey((s) => !s)}>
          {showKey ? 'Hide' : 'Show'}
        </button>
        <span className={clsx('profile__key', effectivelyStored && 'profile__key--set')}>
          {effectivelyStored ? (
            <>
              <Icon name="check" size={12} /> Key stored securely for {provider} (write-only)
            </>
          ) : (
            `One key per provider, shared by every task assigned to ${provider}. Keys are stored by the backend and never shown again.`
          )}
        </span>
      </div>
    </section>
  );
}
