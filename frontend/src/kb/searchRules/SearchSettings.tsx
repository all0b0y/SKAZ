import { useEffect } from 'react';
import { useServices } from '../state/context';
import { Switch } from '../ui';
import { EMPTY_RULES, SiteList, searchSettingsStore, useSearchSettings } from './sites';

/**
 * N7 · Settings → Search (the last section of the menu): the global rules every chat starts from.
 * Rows come from the settings table (`schema.ts`, so «Find a setting» finds them); each row's control
 * and site list read one shared state and save at once. A chat changes them from the message field.
 */

export type SearchRowId = 'search-never' | 'search-only' | 'search-prefer';
export const SEARCH_ROWS: readonly SearchRowId[] = ['search-never', 'search-only', 'search-prefer'];

function useRules() {
  const { client } = useServices();
  const rules = useSearchSettings(client, (s) => s.rules);
  const saving = useSearchSettings(client, (s) => s.saving);
  const error = useSearchSettings(client, (s) => s.error);
  useEffect(() => { void searchSettingsStore(client).getState().load(); }, [client]);
  const save = (patch: Partial<typeof EMPTY_RULES>) => {
    const store = searchSettingsStore(client).getState();
    void store.save({ ...(store.rules ?? EMPTY_RULES), ...patch });
  };
  return { rules, saving, error, save };
}

/** The control beside a row's label: only «Only these sites» has one (its switch). */
export function SearchRowControl({ id, label }: { id: SearchRowId; label: string }) {
  const { rules, saving, save } = useRules();
  if (id !== 'search-only') return null;
  return <Switch label={label} checked={!!rules?.only_on} disabled={!rules || saving} onChange={(on) => save({ only_on: on })} />;
}

/** The row's site list, under its label. */
export function SearchRowList({ id }: { id: SearchRowId }) {
  const { rules, saving, error, save } = useRules();
  if (!rules) return error ? <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p> : null;
  const list = id === 'search-never'
    ? <SiteList label="Blocked sites" sites={rules.never} disabled={saving} onChange={(never) => save({ never })} />
    : id === 'search-only'
      ? <SiteList label="Only these sites" sites={rules.only} dim={!rules.only_on} disabled={saving} onChange={(only) => save({ only })} />
      : <SiteList label="Preferred sites" sites={rules.prefer} disabled={saving} onChange={(prefer) => save({ prefer })} />;
  return (
    <div className="kb-srow__below">
      {list}
      {id === 'search-prefer' && (
        <p className="kb-srow__hint">Google Scholar can’t be searched directly — its results aren’t in the agents’ web search. Scientific sites such as arxiv.org, semanticscholar.org or pubmed.ncbi.nlm.nih.gov work.</p>
      )}
      {id === 'search-never' && error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
    </div>
  );
}
