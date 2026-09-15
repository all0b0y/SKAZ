import { useState } from 'react';
import { clsx } from 'clsx';
import { Icon } from '../ui/Icon';
import { isLocalProvider, needsBaseUrl, TASK_LABELS } from './providers';
import type { Profile, ProfileUpdate, ProviderName, TaskKind } from '../../api/types';

interface ProviderCredentialsProps {
  provider: ProviderName;
  /** Tasks currently (draft-aware) assigned to this provider, in asr/agent/notes order. */
  tasks: TaskKind[];
  /** Saved settings profiles, keyed by task. */
  profiles: Record<TaskKind, Profile>;
  /** Current per-task drafts, keyed by task. */
  drafts: Record<TaskKind, ProfileUpdate>;
  /** Writes `api_key` into the drafts of every listed task. */
  onApplyKey: (tasks: TaskKind[], value: string) => void;
  /** Writes `base_url` into the drafts of every listed task. */
  onChangeBaseUrl: (tasks: TaskKind[], value: string) => void;
}

// One card per provider that at least one task profile actually uses. A single
// key/base_url pair is collected here and, on save, copied into every task
// profile that uses this provider — the backend still receives three
// independent profiles, only the UI collapses their shared credential.
export function ProviderCredentials({
  provider,
  tasks,
  profiles,
  drafts,
  onApplyKey,
  onChangeBaseUrl,
}: ProviderCredentialsProps) {
  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [pendingKey, setPendingKey] = useState('');

  const taskLabel = tasks.map((t) => TASK_LABELS[t]).join(', ');

  if (isLocalProvider(provider)) {
    return (
      <section className="profile provider-card">
        <header className="profile__head">
          <h4>{provider}</h4>
          <p>Used by {taskLabel}</p>
        </header>
        <p className="profile__note">Runs locally — no API key required.</p>
      </section>
    );
  }

  // has_api_key describes the SAVED profile's provider, so a stored key may only be
  // claimed when a task's saved provider still equals this card's provider. A draft
  // api_key of '' is a pending removal and a non-empty draft is a typed-but-unsaved
  // replacement; neither is "stored", mirroring ProfileEditor's original rule.
  const hasStoredKey = (task: TaskKind): boolean =>
    profiles[task].provider === provider && profiles[task].has_api_key === true && drafts[task].api_key === undefined;

  // Only tasks whose *saved* (backend-confirmed) provider already matches this
  // card can disagree about a previously-stored key; a task freshly switched
  // into this provider in the current draft has nothing stored yet, so it is
  // not a "surprise" mismatch and is excluded from the comparison.
  const savedTasks = tasks.filter((t) => profiles[t].provider === provider);
  const storedStates = savedTasks.map(hasStoredKey);
  const mismatch = storedStates.length > 1 && storedStates.some((s) => s !== storedStates[0]);
  const allStored = storedStates.length > 0 && storedStates.every(Boolean);

  // tasks is always non-empty when this card renders (it exists because at
  // least one task uses this provider); the fallback only satisfies TS.
  const baseUrlTask: TaskKind = tasks[0] ?? 'agent';
  const baseUrlValues = tasks.map((t) => drafts[t].base_url ?? profiles[t].base_url ?? '');
  const baseUrlDiffers = new Set(baseUrlValues).size > 1;
  // Local, uncontrolled-by-props state so typing accumulates immediately —
  // mirrors the API key field below. Computed once at mount; a provider
  // switch remounts this whole card (SettingsPanel keys it by provider), so
  // the initial value always matches the card's actual provider.
  const [baseUrlInput, setBaseUrlInput] = useState(
    () => drafts[baseUrlTask]?.base_url ?? profiles[baseUrlTask].base_url ?? '',
  );

  return (
    <section className="profile provider-card">
      <header className="profile__head">
        <h4>{provider}</h4>
        <p>Used by {taskLabel}</p>
      </header>

      {needsBaseUrl(provider) && (
        <div className="field">
          <label htmlFor={`provider-${provider}-baseurl`}>Base URL</label>
          <input
            id={`provider-${provider}-baseurl`}
            type="url"
            placeholder="https://host/v1"
            value={baseUrlInput}
            onChange={(e) => {
              setBaseUrlInput(e.target.value);
              onChangeBaseUrl(tasks, e.target.value);
            }}
          />
          {baseUrlDiffers && (
            <p className="profile__note profile__note--warn">
              <Icon name="warning" size={13} /> Base URL differs across profiles using {provider}. Saving
              applies this value to all of them.
            </p>
          )}
        </div>
      )}

      {mismatch ? (
        <div className="field">
          <label htmlFor={`provider-${provider}-key`}>API key</label>
          <p className="profile__note profile__note--warn">
            <Icon name="warning" size={13} /> Stored keys differ across profiles using {provider}:{' '}
            {savedTasks.map((t, i) => (
              <span key={t}>
                {i > 0 && ', '}
                {TASK_LABELS[t]} ({hasStoredKey(t) ? 'stored' : 'not set'})
              </span>
            ))}
            . Nothing is changed until you apply a key to all of them.
          </p>
          <input
            id={`provider-${provider}-key`}
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            placeholder="New key to apply to all"
            value={pendingKey}
            onChange={(e) => setPendingKey(e.target.value)}
          />
          <button type="button" className="field__toggle" onClick={() => setShowKey((s) => !s)}>
            {showKey ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            className="profile__download"
            disabled={!pendingKey}
            onClick={() => {
              onApplyKey(tasks, pendingKey);
              setPendingKey('');
            }}
          >
            Apply this key to all {tasks.length} profiles
          </button>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={`provider-${provider}-key`}>API key</label>
          <input
            id={`provider-${provider}-key`}
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            placeholder={allStored ? '•••••••• stored' : 'Not set'}
            value={keyInput}
            onChange={(e) => {
              setKeyInput(e.target.value);
              onApplyKey(tasks, e.target.value);
            }}
          />
          <button type="button" className="field__toggle" onClick={() => setShowKey((s) => !s)}>
            {showKey ? 'Hide' : 'Show'}
          </button>
          <span className={clsx('profile__key', allStored && 'profile__key--set')}>
            {allStored ? (
              <>
                <Icon name="check" size={12} /> Key stored securely for {tasks.length}{' '}
                {tasks.length === 1 ? 'profile' : 'profiles'} (write-only)
              </>
            ) : (
              `Applies to ${tasks.length} ${tasks.length === 1 ? 'profile' : 'profiles'} using ${provider}. Keys are stored by the backend and never shown again.`
            )}
          </span>
        </div>
      )}
    </section>
  );
}
