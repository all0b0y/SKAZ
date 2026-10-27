import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorText } from '../api/client';
import type { KbClient } from '../api/client';
import { saveSearchSettings, searchSettings, type KbSearchSettings } from '../api/searchRules';
import { Icon } from '../ui';

/**
 * N7: the user's search rules in the interface. A domain covers its subdomains; the backend keeps
 * the rules in code (links outside them never reach the agent). Here: the site chips and the shared
 * Settings → Search state.
 */

/** Web rules with every list present (the generated type marks defaulted fields optional). */
export type WebRules = Required<KbSearchSettings>;
export const EMPTY_RULES: WebRules = { never: [], only_on: false, only: [], prefer: [] };
export const full = (rules: KbSearchSettings | null | undefined): WebRules => ({
  never: rules?.never ?? [], only_on: rules?.only_on ?? false, only: rules?.only ?? [], prefer: rules?.prefer ?? [],
});

/**
 * `https://www.Example.com/path` → `example.com`; `null` when it is no site. The backend normalises
 * again (IDNA, labels) and refuses what it can't use — this only gives a quick answer while typing.
 */
export function siteOf(text: string): string | null {
  let raw = text.trim().toLowerCase();
  if (!raw || /\s/.test(raw)) return null;
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  raw = raw.split('/')[0]!.split('?')[0]!.split('#')[0]!.split(':')[0]!;
  raw = raw.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '').replace(/^www\./, '');
  if (!raw.includes('.') || raw.split('.').some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return null;
  if (/^[\d.]+$/.test(raw)) return null;
  return /^[\p{L}\p{N}.-]+$/u.test(raw) ? raw : null;
}

/** «arxiv.org +3» */
export function sitesShort(sites: readonly string[], shown = 1): string {
  if (sites.length <= shown) return sites.join(', ');
  return `${sites.slice(0, shown).join(', ')} +${sites.length - shown}`;
}

export interface SiteListProps {
  /** Accessible name of the list («Blocked sites»). */
  label: string;
  sites: readonly string[];
  /** Sites from Settings shown dashed, without a remove button (a chat can't lift a global Never). */
  inherited?: readonly string[];
  onChange: (sites: string[]) => void;
  disabled?: boolean;
  /** Muted (e.g. «Only these sites» while the switch is off) — still editable. */
  dim?: boolean;
}

/** Site chips with remove, and «Add site» → an inline field (Enter adds, Escape cancels). */
export function SiteList({ label, sites, inherited = [], onChange, disabled = false, dim = false }: SiteListProps) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (adding) input.current?.focus(); }, [adding]);

  const add = () => {
    const site = siteOf(text);
    if (!site) { setProblem('Write it like example.com.'); return; }
    setProblem(null);
    setText('');
    setAdding(false);
    if (!sites.includes(site) && !inherited.includes(site)) onChange([...sites, site]);
  };

  return (
    <div className={`kb-sites${dim ? ' is-dim' : ''}`}>
      <ul className="kb-sites__list" aria-label={label}>
        {inherited.map((site) => (
          <li key={`s-${site}`} className="kb-site is-inherited" title="From Settings — change it there">
            <span className="kb-site__name">{site}</span><span className="kb-site__from">· Settings</span>
          </li>
        ))}
        {sites.map((site) => (
          <li key={site} className="kb-site">
            <span className="kb-site__name">{site}</span>
            <button type="button" className="kb-site__remove" aria-label={`Remove ${site}`} disabled={disabled}
              onClick={() => onChange(sites.filter((s) => s !== site))}><Icon name="close" size={11} /></button>
          </li>
        ))}
        <li className="kb-sites__add">
          {adding ? (
            <input ref={input} className="kb-site-input" aria-label={`Add to ${label.toLowerCase()}`} placeholder="example.com" value={text}
              disabled={disabled}
              onChange={(e) => { setText(e.target.value); setProblem(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); add(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(false); setText(''); setProblem(null); }
              }}
              onBlur={() => { if (!text.trim()) { setAdding(false); setProblem(null); } }} />
          ) : (
            <button type="button" className="kb-site-add" disabled={disabled} onClick={() => setAdding(true)}>
              <Icon name="plus" size={12} />Add site
            </button>
          )}
        </li>
      </ul>
      {problem && <p className="kb-sites__problem" role="alert">{problem}</p>}
    </div>
  );
}

// ---- Settings → Search: one shared state for its rows ----------------------------------------

export interface SearchSettingsState {
  rules: WebRules | null;
  error: string | null;
  saving: boolean;
  load: () => Promise<void>;
  save: (next: WebRules) => Promise<void>;
}

const stores = new WeakMap<KbClient, StoreApi<SearchSettingsState>>();

export function searchSettingsStore(client: KbClient): StoreApi<SearchSettingsState> {
  let store = stores.get(client);
  if (!store) {
    store = createStore<SearchSettingsState>((set, get) => ({
      rules: null,
      error: null,
      saving: false,
      load: async () => {
        try {
          set({ rules: full(await searchSettings(client)), error: null });
        } catch (e) {
          set({ error: errorText(e) });
        }
      },
      save: async (next) => {
        const before = get().rules;
        set({ rules: next, saving: true, error: null });
        try {
          set({ rules: full(await saveSearchSettings(client, next)), saving: false });
        } catch (e) {
          set({ rules: before, saving: false, error: errorText(e) });
        }
      },
    }));
    stores.set(client, store);
  }
  return store;
}

export function useSearchSettings<T>(client: KbClient, pick: (s: SearchSettingsState) => T): T {
  return useStore(searchSettingsStore(client), pick);
}
