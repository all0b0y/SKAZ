import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorText } from '../api/client';
import {
  createScienceClient,
  type ScienceClient,
} from '../api/science';
import {
  createMaintenanceClient,
  type MaintenanceClient,
} from '../api/maintenance';
import type {
  KbOpenAlexKeyUpdate,
  KbScienceEgress,
  KbScienceSettings,
  KbScienceSettingsUpdate,
  KbWeeklySettings,
  KbWeeklySettingsUpdate,
} from '../../api/kb/types.gen';
import { useOptionalServices } from '../state/context';
import type { KbServices } from '../state/context';
import { Button, Icon, Modal, Switch } from '../ui';
import { clockOrDate, shortTime } from '../ui/time';

// ---- Context for FakeKb in tests or overrides ------------------------------------------------

export interface FakeKbOverride {
  science?: ScienceClient;
  maintenance?: MaintenanceClient;
}

const FakeKbContext = createContext<FakeKbOverride | null>(null);

export function FakeKbProvider({
  fake,
  children,
}: {
  fake: FakeKbOverride;
  children: ReactNode;
}) {
  return <FakeKbContext.Provider value={fake}>{children}</FakeKbContext.Provider>;
}

export function useFakeKb(): FakeKbOverride | null {
  return useContext(FakeKbContext);
}

function useResolvedScienceClient(override?: ScienceClient): ScienceClient {
  const fake = useFakeKb();
  const client = useOptionalServices()?.client;
  return useMemo(() => {
    if (override) return override;
    if (fake?.science) return fake.science;
    if (!client) throw new Error('KbServicesProvider is missing');
    return createScienceClient(client);
  }, [override, fake?.science, client]);
}

function useResolvedMaintenanceClient(override?: MaintenanceClient): MaintenanceClient {
  const fake = useFakeKb();
  const client = useOptionalServices()?.client;
  return useMemo(() => {
    if (override) return override;
    if (fake?.maintenance) return fake.maintenance;
    if (!client) throw new Error('KbServicesProvider is missing');
    return createMaintenanceClient(client);
  }, [override, fake?.maintenance, client]);
}

// ---- Science settings store ------------------------------------------------------------------

export interface ScienceSettingsState {
  settings: KbScienceSettings | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  update: (patch: KbScienceSettingsUpdate) => Promise<{ ok: boolean; error?: string }>;
  setKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
}

const scienceStores = new WeakMap<object, StoreApi<ScienceSettingsState>>();

export function scienceSettingsStore(client: ScienceClient): StoreApi<ScienceSettingsState> {
  let store = scienceStores.get(client);
  if (!store) {
    store = createStore<ScienceSettingsState>((set, get) => ({
      settings: null,
      loading: false,
      saving: false,
      error: null,
      load: async () => {
        if (get().loading || get().saving) return;
        set({ loading: true, error: null });
        try {
          const settings = await client.settings();
          set({ settings, loading: false, error: null });
        } catch (e) {
          set({ loading: false, error: errorText(e) });
        }
      },
      update: async (patch: KbScienceSettingsUpdate) => {
        set({ saving: true, error: null });
        try {
          const settings = await client.update_settings(patch);
          set({ settings, saving: false, error: null });
          return { ok: true };
        } catch (e) {
          const err = errorText(e);
          set({ saving: false, error: err });
          return { ok: false, error: err };
        }
      },
      setKey: async (key: string) => {
        set({ saving: true, error: null });
        try {
          const settings = await client.set_key({ key } as KbOpenAlexKeyUpdate);
          set({ settings, saving: false, error: null });
          return { ok: true };
        } catch (e) {
          const err = errorText(e);
          set({ saving: false, error: err });
          return { ok: false, error: err };
        }
      },
    }));
    scienceStores.set(client, store);
  }
  return store;
}

export function useScienceSettings<T>(
  client: ScienceClient,
  pick: (s: ScienceSettingsState) => T,
): T {
  return useStore(scienceSettingsStore(client), pick);
}

// ---- Weekly settings store -------------------------------------------------------------------

export interface WeeklySettingsState {
  settings: KbWeeklySettings | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  update: (patch: KbWeeklySettingsUpdate) => Promise<{ ok: boolean; error?: string }>;
}

const weeklyStores = new WeakMap<object, StoreApi<WeeklySettingsState>>();

export function weeklySettingsStore(client: MaintenanceClient): StoreApi<WeeklySettingsState> {
  let store = weeklyStores.get(client);
  if (!store) {
    store = createStore<WeeklySettingsState>((set, get) => ({
      settings: null,
      loading: false,
      saving: false,
      error: null,
      load: async () => {
        if (get().loading || get().saving) return;
        set({ loading: true, error: null });
        try {
          const settings = await client.settings();
          set({ settings, loading: false, error: null });
        } catch (e) {
          set({ loading: false, error: errorText(e) });
        }
      },
      update: async (patch: KbWeeklySettingsUpdate) => {
        set({ saving: true, error: null });
        try {
          const settings = await client.update_settings(patch);
          set({ settings, saving: false, error: null });
          return { ok: true };
        } catch (e) {
          const err = errorText(e);
          set({ saving: false, error: err });
          return { ok: false, error: err };
        }
      },
    }));
    weeklyStores.set(client, store);
  }
  return store;
}

export function useWeeklySettings<T>(
  client: MaintenanceClient,
  pick: (s: WeeklySettingsState) => T,
): T {
  return useStore(weeklySettingsStore(client), pick);
}

// ---- Components ------------------------------------------------------------------------------

/**
 * Settings → Search → "Scientific papers & preprints": switch enabling science integration.
 * Requires explicit consent (what leaves: topics, DOIs, IDs only) when enabling.
 */
export function ScienceSwitchRow({
  label,
  client: clientProp,
}: {
  label: string;
  client?: ScienceClient;
}) {
  const client = useResolvedScienceClient(clientProp);

  const settings = useScienceSettings(client, (s) => s.settings);
  const saving = useScienceSettings(client, (s) => s.saving);
  const error = useScienceSettings(client, (s) => s.error);

  const [asking, setAsking] = useState(false);

  useEffect(() => {
    void scienceSettingsStore(client).getState().load();
  }, [client]);

  if (!settings) {
    if (error) {
      return (
        <span className="kb-inline-error kb-inline-error--flat kb-srow__fail" role="alert">
          Couldn’t read: {error}
          <Button
            size="sm"
            variant="quiet"
            icon="retry"
            onClick={() => void scienceSettingsStore(client).getState().load()}
          >
            Try again
          </Button>
        </span>
      );
    }
    return <span className="kb-muted" role="status">Reading…</span>;
  }

  const onToggle = (next: boolean) => {
    if (next) {
      setAsking(true);
    } else {
      void scienceSettingsStore(client).getState().update({ enabled: false });
    }
  };

  const allowConsent = async () => {
    setAsking(false);
    await scienceSettingsStore(client).getState().update({
      enabled: true,
      consent: 'topics_dois_ids',
    });
  };

  return (
    <>
      {settings.enabled ? (
        <>
          <span className="kb-status kb-status--ok">
            <Icon name="check" size={13} />
            Enabled
          </span>
          {settings.consent_at && (
            <span
              className="kb-muted"
              title={new Date(settings.consent_at).toLocaleString('en-GB')}
            >
              Consent: {shortTime(settings.consent_at)}
            </span>
          )}
        </>
      ) : (
        <span className="kb-muted">Off</span>
      )}
      <Switch
        label={label}
        checked={settings.enabled}
        disabled={saving}
        onChange={(next) => void onToggle(next)}
      />
      {error && (
        <span className="kb-inline-error kb-inline-error--flat" role="alert">
          {error}
        </span>
      )}

      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Allow scientific search?"
        className="kb-confirm"
        testId="confirm-science"
      >
        <div className="kb-confirm__body">
          <p>
            While exploring or researching scientific topics, SKAZ connects to OpenAlex, arXiv and Crossref.
          </p>
          <p>
            <strong>What leaves this computer:</strong> topics, DOIs, and IDs only. Never your notes, chats, or materials.
          </p>
          <p className="kb-muted">You can turn this off at any time.</p>
        </div>
        <footer className="kb-confirm__foot">
          <Button onClick={() => setAsking(false)}>Cancel</Button>
          <Button variant="fill" onClick={() => void allowConsent()}>
            Allow
          </Button>
        </footer>
      </Modal>
    </>
  );
}

/**
 * Settings → Search → "OpenAlex key": write-only key field with "Configured" state and Remove action.
 */
/** B1-6 (user decision A): the secret store couldn't be read, so a saved key isn't used — said here too. */
function KeyUnreadableNotice({ settings }: { settings: KbServices['settings'] }) {
  const unreadable = useStore(settings, (s) =>
    (s.health.value?.sections ?? []).some((section) =>
      section.problems.some((problem) => problem.id === 'key-openalex-unreadable'),
    ),
  );
  if (!unreadable) return null;
  return (
    <span className="kb-inline-error kb-inline-error--flat" role="alert">
      SKAZ couldn’t read your OpenAlex key. Scientific search runs without it, with the smaller keyless limit.
    </span>
  );
}

export function OpenAlexKeyRow({
  label,
  client: clientProp,
}: {
  label: string;
  client?: ScienceClient;
}) {
  const client = useResolvedScienceClient(clientProp);

  const settings = useScienceSettings(client, (s) => s.settings);
  const saving = useScienceSettings(client, (s) => s.saving);
  const error = useScienceSettings(client, (s) => s.error);

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const id = useId();
  const services = useOptionalServices();

  useEffect(() => {
    void scienceSettingsStore(client).getState().load();
  }, [client]);

  if (!settings) {
    if (error) {
      return (
        <span className="kb-inline-error kb-inline-error--flat kb-srow__fail" role="alert">
          Couldn’t read: {error}
          <Button
            size="sm"
            variant="quiet"
            icon="retry"
            onClick={() => void scienceSettingsStore(client).getState().load()}
          >
            Try again
          </Button>
        </span>
      );
    }
    return <span className="kb-muted" role="status">Reading…</span>;
  }

  if (editing) {
    return (
      <form
        className="kb-keyform"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!value.trim()) return;
          const res = await scienceSettingsStore(client).getState().setKey(value.trim());
          if (res.ok) {
            setEditing(false);
            setValue('');
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(false);
            setValue('');
          }
        }}
      >
        <label htmlFor={id} className="kb-visually-hidden">
          {label}
        </label>
        <input
          id={id}
          className="kb-attachform__input kb-keyform__input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste OpenAlex key"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <Button size="sm" variant="fill" type="submit" busy={saving} disabled={!value.trim()}>
          Save
        </Button>
        <Button
          size="sm"
          variant="quiet"
          onClick={() => {
            setEditing(false);
            setValue('');
          }}
        >
          Cancel
        </Button>
        {error && (
          <span className="kb-inline-error kb-inline-error--flat" role="alert">
            {error}
          </span>
        )}
      </form>
    );
  }

  return (
    <>
      {services && <KeyUnreadableNotice settings={services.settings} />}
      {settings.openalex_key_configured ? (
        <>
          <span className="kb-status kb-status--ok">
            <Icon name="check" size={13} />
            Configured
          </span>
          <Button size="sm" onClick={() => setEditing(true)}>
            Replace…
          </Button>
          <Button
            size="sm"
            variant="quiet"
            busy={saving}
            onClick={async () => {
              await scienceSettingsStore(client).getState().setKey('');
            }}
          >
            Remove
          </Button>
        </>
      ) : (
        <>
          <span className="kb-muted">No key</span>
          <Button size="sm" onClick={() => setEditing(true)}>
            Add key…
          </Button>
        </>
      )}
      {error && (
        <span className="kb-inline-error kb-inline-error--flat" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * Settings → Search → "Requests journal": modal viewing outgoing requests to OpenAlex, arXiv, Crossref.
 */
export function ScienceJournalRow({
  client: clientProp,
}: {
  client?: ScienceClient;
}) {
  const client = useResolvedScienceClient(clientProp);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<KbScienceEgress[]>([]);

  const loadJournal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.journal({ limit: 100 });
      setRecords(res.records);
      setLoading(false);
    } catch (e) {
      setError(errorText(e));
      setLoading(false);
    }
  }, [client]);

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setOpen(true);
          void loadJournal();
        }}
      >
        Show…
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Science requests journal"
        className="kb-confirm kb-activity"
        testId="science-journal"
      >
        <div className="kb-confirm__body kb-activity__body">
          <p className="kb-muted">
            What was sent to OpenAlex, arXiv and Crossref — newest first. Only topics, DOIs and IDs leave this computer — never your notes, chats or material text.
          </p>
          {error && (
            <p className="kb-inline-error kb-inline-error--flat" role="alert">
              <Icon name="error" size={13} />
              Couldn’t read journal: {error}
            </p>
          )}
          {!error && loading && records.length === 0 && (
            <p className="kb-muted" role="status">
              Reading…
            </p>
          )}
          {!error && !loading && records.length === 0 && (
            <p className="kb-muted" role="status">
              No requests recorded yet.
            </p>
          )}
          {records.length > 0 && (
            <ul className="kb-activity__list" aria-label="Requests, newest first" tabIndex={0}>
              {records.map((entry) => {
                const payloadParts: string[] = [];
                if (entry.payload.topics && entry.payload.topics.length > 0) {
                  payloadParts.push(`Topics: ${entry.payload.topics.join(', ')}`);
                }
                if (entry.payload.dois && entry.payload.dois.length > 0) {
                  payloadParts.push(`DOIs: ${entry.payload.dois.join(', ')}`);
                }
                if (entry.payload.ids && entry.payload.ids.length > 0) {
                  payloadParts.push(`IDs: ${entry.payload.ids.join(', ')}`);
                }
                const result =
                  entry.status_code !== null && entry.status_code !== undefined
                    ? `${entry.outcome} · ${entry.status_code}`
                    : entry.outcome;

                return (
                  <li key={entry.id} className="kb-activity__item">
                    <div className="kb-activity__line">
                      <b className="kb-activity__op">
                        {entry.provider} · {entry.operation}
                      </b>
                      <span className="kb-muted kb-activity__at">
                        {clockOrDate(entry.requested_at)}
                      </span>
                    </div>
                    <div className="kb-activity__meta kb-muted">
                      <span>{entry.destination_host}</span>
                      <span
                        className={
                          entry.outcome === 'succeeded' ? undefined : 'kb-activity__bad'
                        }
                      >
                        {result}
                      </span>
                    </div>
                    {payloadParts.length > 0 && (
                      <div className="kb-activity__meta kb-muted">
                        {payloadParts.map((p, idx) => (
                          <span key={idx}>{p}</span>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="kb-confirm__foot">
          <Button icon="retry" busy={loading} onClick={() => void loadJournal()}>
            Refresh
          </Button>
          <Button variant="fill" onClick={() => setOpen(false)}>
            Done
          </Button>
        </footer>
      </Modal>
    </>
  );
}

/**
 * Settings → Search → "Weekly check": weekly upkeep scheduler switch with last run and next run.
 */
export function WeeklyCheckRow({
  label,
  client: clientProp,
}: {
  label: string;
  client?: MaintenanceClient;
}) {
  const client = useResolvedMaintenanceClient(clientProp);

  const settings = useWeeklySettings(client, (s) => s.settings);
  const loading = useWeeklySettings(client, (s) => s.loading);
  const saving = useWeeklySettings(client, (s) => s.saving);
  const error = useWeeklySettings(client, (s) => s.error);

  useEffect(() => {
    void weeklySettingsStore(client).getState().load();
  }, [client]);

  if (!settings) {
    if (error) {
      return (
        <span className="kb-inline-error kb-inline-error--flat kb-srow__fail" role="alert">
          Couldn’t read: {error}
          <Button
            size="sm"
            variant="quiet"
            icon="retry"
            onClick={() => void weeklySettingsStore(client).getState().load()}
          >
            Try again
          </Button>
        </span>
      );
    }
    return <span className="kb-muted" role="status">Reading…</span>;
  }

  const lastText = settings.last_completed_at
    ? shortTime(settings.last_completed_at)
    : 'Never';
  const nextText = settings.missed
    ? 'At next launch (missed)'
    : settings.next_due_at
      ? shortTime(settings.next_due_at)
      : 'Scheduled weekly';
  const waitingText =
    settings.candidates_waiting > 0 ? ` · ${settings.candidates_waiting} waiting` : '';

  return (
    <>
      {settings.enabled ? (
        <span className="kb-muted">
          Last: {lastText} · Next: {nextText}
          {waitingText}
        </span>
      ) : (
        <span className="kb-muted">Off</span>
      )}
      <Switch
        label={label}
        checked={settings.enabled}
        disabled={saving || loading}
        onChange={(next) =>
          void weeklySettingsStore(client).getState().update({ enabled: next })
        }
      />
      {error && (
        <span className="kb-inline-error kb-inline-error--flat" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * Settings → Search section full component (for rendering as its own section).
 */
export function SearchSection({
  scienceClient,
  maintenanceClient,
}: {
  scienceClient?: ScienceClient;
  maintenanceClient?: MaintenanceClient;
}) {
  return (
    <div className="kb-search-section">
      <section className="kb-sgroup" aria-label="Scientific sources">
        <h4 className="kb-sgroup__title">Scientific sources</h4>
        <div className="kb-srow" data-row="science-enabled">
          <div className="kb-srow__text">
            <div className="kb-srow__label">Scientific papers & preprints</div>
            <div className="kb-srow__hint">
              OpenAlex, arXiv and Crossref. Only topics, DOIs and IDs leave this computer — never your notes, chats or material text.
            </div>
          </div>
          <div className="kb-srow__control">
            <ScienceSwitchRow
              label="Scientific papers & preprints"
              client={scienceClient}
            />
          </div>
        </div>
        <div className="kb-srow" data-row="openalex-key">
          <div className="kb-srow__text">
            <div className="kb-srow__label">OpenAlex key</div>
            <div className="kb-srow__hint">
              Optional free key for full text · stored in your secret store
            </div>
          </div>
          <div className="kb-srow__control">
            <OpenAlexKeyRow label="OpenAlex key" client={scienceClient} />
          </div>
        </div>
        <div className="kb-srow" data-row="science-journal">
          <div className="kb-srow__text">
            <div className="kb-srow__label">Requests journal</div>
            <div className="kb-srow__hint">
              What was sent to OpenAlex, arXiv and Crossref — topics, DOIs and IDs only
            </div>
          </div>
          <div className="kb-srow__control">
            <ScienceJournalRow client={scienceClient} />
          </div>
        </div>
      </section>

      <section className="kb-sgroup" aria-label="Weekly check">
        <h4 className="kb-sgroup__title">Weekly check</h4>
        <div className="kb-srow" data-row="weekly-check">
          <div className="kb-srow__text">
            <div className="kb-srow__label">Weekly check</div>
            <div className="kb-srow__hint">
              Checks scientific sources and your wiki once a week · new versions, retractions, contradictions
            </div>
          </div>
          <div className="kb-srow__control">
            <WeeklyCheckRow label="Weekly check" client={maintenanceClient} />
          </div>
        </div>
      </section>
    </div>
  );
}
