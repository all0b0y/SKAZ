import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Icon } from '../ui/Icon';
import type { ModelInfo, Profile, ProfileUpdate, ProviderName, TaskKind } from '../../api/types';

const PROVIDERS: Record<TaskKind, ProviderName[]> = {
  asr: ['local-whisper', 'openai', 'openrouter', 'openai-compatible'],
  agent: ['openrouter', 'openai', 'anthropic', 'openai-compatible'],
  notes: ['openrouter', 'openai', 'anthropic', 'openai-compatible'],
};

const needsBaseUrl = (p: ProviderName): boolean => p === 'openai-compatible';
const needsKey = (p: ProviderName): boolean => p !== 'local-whisper';

interface ProfileEditorProps {
  task: TaskKind;
  label: string;
  description: string;
  profile: Profile;
  draft: ProfileUpdate;
  onChange: (update: ProfileUpdate) => void;
}

export function ProfileEditor({ task, label, description, profile, draft, onChange }: ProfileEditorProps) {
  const loadModels = useStore((s) => s.loadModels);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [custom, setCustom] = useState(false);
  const [query, setQuery] = useState('');

  const provider = (draft.provider ?? profile.provider) as ProviderName;
  const model = draft.model ?? profile.model;

  // Keep the stored model out of the load effect deps so selecting a model does
  // not re-fetch the catalog; the ref lets the fresh load still detect a custom ID.
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setCatalogError(null);
    // A provider (or task) switch invalidates the previous catalog and query;
    // clear them eagerly so no stale option or search survives the change.
    setModels([]);
    setQuery('');
    loadModels(provider, task)
      .then((list) => {
        if (!active) return;
        setModels(list);
        const stored = modelRef.current;
        setCustom(list.length > 0 && !!stored && !list.some((m) => m.id === stored));
      })
      .catch((err: unknown) => {
        if (active) setCatalogError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      // A late resolve from a superseded provider is dropped by this flag.
      active = false;
    };
  }, [provider, task, loadModels]);

  // A text task only accepts models that can emit text. An empty/absent
  // output_modalities (stale or partial catalog) is retained — we cannot prove it
  // is non-text — while an explicit non-text list (image/audio/video-only) is dropped.
  const emitsText = (m: ModelInfo): boolean => {
    const out = m.output_modalities;
    return !out || out.length === 0 || out.includes('text');
  };
  // Defend against a stale catalog that still lists non-text-output models: never
  // offer them as selectable for a text task, even if the backend forgot to filter.
  const selectable = task === 'asr' ? models : models.filter(emitsText);

  const trimmedQuery = query.trim().toLowerCase();
  const matches = trimmedQuery
    ? selectable.filter(
        (m) => m.name.toLowerCase().includes(trimmedQuery) || m.id.toLowerCase().includes(trimmedQuery),
      )
    : selectable;
  const selectedModel = models.find((m) => m.id === model);
  // When the catalog is empty or failed to load we still owe the user their exact
  // stored ID: synthesize a placeholder option so the selection stays visible and the
  // <select> keeps its value instead of silently resetting to "Select a model".
  const storedEntry: ModelInfo | undefined =
    selectedModel ??
    (model
      ? { id: model, name: model, input_modalities: [], output_modalities: undefined, verified: false }
      : undefined);
  // Never silently drop the stored selection from view, even when the query hides it
  // or the selection itself is not offered as a fresh choice — preserve the exact ID.
  const visibleModels =
    storedEntry && !matches.some((m) => m.id === storedEntry.id)
      ? [storedEntry, ...matches]
      : matches;
  // The no-match hint reflects the query against the offered catalog, not the pinned
  // selection, so a stored model can stay visible while "no models match" still shows.
  const noResults = trimmedQuery.length > 0 && matches.length === 0;
  const unverifiedSelection = selectedModel && !selectedModel.verified;
  // A text task cannot use a non-text-output model. When such a model is the stored
  // selection we still show it (honest provenance) but disable it and warn definitively.
  const isIncompatible = (m: ModelInfo): boolean => task !== 'asr' && !emitsText(m);
  const incompatibleSelection = selectedModel && isIncompatible(selectedModel);

  return (
    <section className="profile">
      <header className="profile__head">
        <h4>{label}</h4>
        <p>{description}</p>
      </header>

      <div className="field">
        <label htmlFor={`${task}-provider`}>Provider</label>
        <select
          id={`${task}-provider`}
          value={provider}
          onChange={(e) => {
            setCustom(false);
            onChange({ ...draft, provider: e.target.value as ProviderName, model: '' });
          }}
        >
          {PROVIDERS[task].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {needsBaseUrl(provider) && (
        <div className="field">
          <label htmlFor={`${task}-baseurl`}>Base URL</label>
          <input
            id={`${task}-baseurl`}
            type="url"
            placeholder="https://host/v1"
            value={draft.base_url ?? profile.base_url ?? ''}
            onChange={(e) => onChange({ ...draft, base_url: e.target.value })}
          />
        </div>
      )}

      <div className="field">
        <label htmlFor={`${task}-model`}>Model</label>
        {custom ? (
          <input
            id={`${task}-model`}
            type="text"
            placeholder="Custom model ID"
            value={model}
            onChange={(e) => onChange({ ...draft, model: e.target.value })}
          />
        ) : (
          <>
            <input
              id={`${task}-model-search`}
              type="search"
              className="field__search"
              placeholder="Search by name or exact ID"
              aria-label="Search models"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              id={`${task}-model`}
              value={model}
              onChange={(e) => onChange({ ...draft, model: e.target.value })}
            >
              <option value="">{loading ? 'Loading models…' : 'Select a model'}</option>
              {visibleModels.map((m) => (
                <option key={m.id} value={m.id} disabled={isIncompatible(m)}>
                  {m.name}
                  {m.verified ? ' ✓' : ' (unverified)'}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="button" className="field__toggle" onClick={() => setCustom((c) => !c)}>
          {custom ? 'Choose from catalog' : 'Enter a custom model ID'}
        </button>
      </div>

      {catalogError && (
        <p className="profile__note profile__note--warn">
          <Icon name="warning" size={13} /> Catalog unavailable: {catalogError}
        </p>
      )}
      {!custom && noResults && (
        <p className="profile__note">
          No models match “{query.trim()}”. Clear the search or enter a custom model ID.
        </p>
      )}
      {custom && (
        <p className="profile__note profile__note--warn">
          <Icon name="warning" size={13} /> Custom model IDs are sent exactly as typed. Compatibility with
          this task is not yet confirmed; the backend checks it against the supported provider catalog when
          you save, where that catalog is available.
        </p>
      )}
      {!custom && incompatibleSelection && (
        <p className="profile__note profile__note--warn">
          <Icon name="warning" size={13} /> This model does not list text output and is incompatible with this task.
          It is shown only to preserve your stored selection; choose a text-capable model.
        </p>
      )}
      {!custom && unverifiedSelection && task === 'asr' && (
        <p className="profile__note profile__note--warn">
          <Icon name="warning" size={13} /> This model advertises audio input but has not been verified for
          transcription. The backend will flag it until a real transcription succeeds.
        </p>
      )}
      {!custom && unverifiedSelection && task !== 'asr' && (
        <p className="profile__note profile__note--warn">
          <Icon name="warning" size={13} /> This model is in the catalog but has not been verified for this
          task. The catalog does not prove it works; a real request must succeed first.
        </p>
      )}

      {needsKey(provider) && (
        <div className="field">
          <label htmlFor={`${task}-key`}>API key</label>
          <input
            id={`${task}-key`}
            type="password"
            autoComplete="off"
            placeholder={profile.has_api_key ? '•••••••• stored' : 'Not set'}
            value={draft.api_key ?? ''}
            onChange={(e) => onChange({ ...draft, api_key: e.target.value })}
          />
          <span className={clsx('profile__key', profile.has_api_key && 'profile__key--set')}>
            {profile.has_api_key ? (
              <>
                <Icon name="check" size={12} /> Key stored securely (write-only)
              </>
            ) : (
              'Keys are stored by the backend and never shown again.'
            )}
          </span>
        </div>
      )}
    </section>
  );
}
