import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Icon } from '../ui/Icon';
import { LocalModelPreparation } from './LocalModelPreparation';
import type { LocalProviderName, ModelInfo } from '../../api/types';

const LOCAL_PROVIDERS: { provider: LocalProviderName; label: string }[] = [
  { provider: 'local-whisper', label: 'Local Whisper' },
  { provider: 'local-gigachat-mlx', label: 'GigaChat (local)' },
];

/**
 * The Local models section is the one place that manages every local
 * checkpoint this app knows about — installed or not — independent of
 * whatever is currently assigned to a task in Model assignment. Model
 * assignment only ever showed the single selected checkpoint's
 * download/delete panel; this lists the whole known catalog per provider
 * (backend/src/audiohelper/local_models.py has 9 whisper checkpoints + 1
 * GigaChat checkpoint — a small, fixed, honest list, not paginated infinity).
 */
export function LocalModelsBrowser() {
  const loadModels = useStore((s) => s.loadModels);
  const [catalogs, setCatalogs] = useState<Record<LocalProviderName, ModelInfo[] | null>>({
    'local-whisper': null,
    'local-gigachat-mlx': null,
  });
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all(
      LOCAL_PROVIDERS.map(({ provider }) =>
        loadModels(provider, 'asr')
          .then((list) => [provider, list] as const)
          .catch((err: unknown) => {
            if (active) setError(err instanceof Error ? err.message : String(err));
            return [provider, [] as ModelInfo[]] as const;
          }),
      ),
    ).then((results) => {
      if (!active) return;
      setCatalogs((prev) => {
        const next = { ...prev };
        for (const [provider, list] of results) next[provider] = list;
        return next;
      });
    });
    return () => {
      active = false;
    };
  }, [loadModels]);

  const toggle = (key: string) => setExpanded((cur) => (cur === key ? null : key));

  return (
    <div className="local-models">
      {error && (
        <p className="profile__note profile__note--warn">
          <Icon name="warning" size={13} /> {error}
        </p>
      )}
      {LOCAL_PROVIDERS.map(({ provider, label }) => {
        const list = catalogs[provider];
        return (
          <section key={provider} className="local-models__group">
            <h4 className="local-models__group-title">{label}</h4>
            {list === null && <p className="profile__note">Loading catalog…</p>}
            {list !== null && list.length === 0 && (
              <p className="profile__note">No known checkpoints for this provider.</p>
            )}
            {list !== null && list.length > 0 && (
              <ul className="local-models__list">
                {list.map((m) => {
                  const key = `${provider}:${m.id}`;
                  const open = expanded === key;
                  return (
                    <li key={key} className="local-models__item">
                      <button
                        type="button"
                        className="local-models__row"
                        aria-expanded={open}
                        onClick={() => toggle(key)}
                      >
                        <span className="local-models__name">{m.name}</span>
                        <Icon name="chevron" size={14} className={clsx('local-models__chevron', open && 'local-models__chevron--open')} />
                      </button>
                      {open && (
                        <div className="local-models__detail">
                          {m.note && <p className="profile__note">{m.note}</p>}
                          <LocalModelPreparation provider={provider} model={m.id} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
