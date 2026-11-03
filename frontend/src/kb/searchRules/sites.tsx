import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorText } from '../api/client';
import type { KbClient } from '../api/client';
import { saveSearchSettings, searchSettings, type KbSearchSettings } from '../api/searchRules';
import type { KbWebRules } from '../../api/kb/types.gen';
import { Button, Icon } from '../ui';

/**
 * N7: the user's search rules in the interface. A domain covers its subdomains; the backend keeps
 * the rules in code (links outside them never reach the agent). Here: the site chips and the shared
 * Settings → Search state.
 */

/** Web rules with every list present (the generated type marks defaulted fields optional). */
export type WebRules = Required<KbWebRules>;
export type SearchSettings = WebRules & { beta: boolean };
export const EMPTY_RULES: SearchSettings = { never: [], only_on: false, only: [], prefer: [], beta: false };
export const full = (rules: KbWebRules | null | undefined): WebRules => ({
  never: rules?.never ?? [], only_on: rules?.only_on ?? false, only: rules?.only ?? [], prefer: rules?.prefer ?? [],
});
export const fullSettings = (rules: KbSearchSettings | null | undefined): SearchSettings => ({
  ...full(rules), beta: rules?.beta ?? false,
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

/** Site chips: Add, Enter or leaving the field commits; Escape cancels the pending site. */
export function SiteList({ label, sites, inherited = [], onChange, disabled = false, dim = false }: SiteListProps) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (adding) input.current?.focus(); }, [adding]);

  const add = () => {
    if (disabled) return;
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
            <>
              <input ref={input} className="kb-site-input" aria-label={`Add to ${label.toLowerCase()}`} placeholder="example.com" value={text}
                disabled={disabled} aria-invalid={!!problem || undefined}
                onChange={(e) => {
                  const value = e.target.value;
                  e.target.setCustomValidity(value.trim() && !siteOf(value) ? 'Write it like example.com.' : '');
                  setText(value);
                  setProblem(null);
                }}
                onInvalid={(e) => { e.preventDefault(); setProblem('Write it like example.com.'); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(false); setText(''); setProblem(null); }
                }}
                onBlur={() => { if (text.trim()) add(); else { setAdding(false); setProblem(null); } }} />
              <Button size="sm" variant="quiet" disabled={disabled}
                onMouseDown={(e) => { if (e.button === 0) e.preventDefault(); }} onClick={add}>Add</Button>
            </>
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
  rules: SearchSettings | null;
  error: string | null;
  saving: boolean;
  load: () => Promise<void>;
  save: (next: SearchSettings) => Promise<void>;
}

const stores = new WeakMap<KbClient, StoreApi<SearchSettingsState>>();

/** Settings → Search changed: every chat's cached rules (which embed Settings) load again (Q1 n78 M-8). */
export const SEARCH_SETTINGS_CHANGED = 'kb:search-settings-changed';
export function searchSettingsChanged() {
  window.dispatchEvent(new CustomEvent(SEARCH_SETTINGS_CHANGED));
}

export function searchSettingsStore(client: KbClient): StoreApi<SearchSettingsState> {
  let store = stores.get(client);
  if (!store) {
    // Keep edits responsive across blur → click, but serialize complete snapshots on the wire.
    // A read that began before an edit must not replace the newer confirmed/optimistic rules.
    let revision = 0;
    let readVersion = 0;
    let writes = Promise.resolve();
    let confirmed: SearchSettings | null = null;
    store = createStore<SearchSettingsState>((set, get) => ({
      rules: null,
      error: null,
      saving: false,
      load: async () => {
        if (get().saving) return;
        const read = ++readVersion;
        const version = revision;
        try {
          const next = fullSettings(await searchSettings(client));
          if (read === readVersion && version === revision && !get().saving) {
            confirmed = next;
            set({ rules: next, error: null });
          }
        } catch (e) {
          if (read === readVersion && version === revision) set({ error: errorText(e) });
        }
      },
      save: async (next) => {
        const version = ++revision;
        ++readVersion;
        const wanted = { never: [...next.never], only_on: next.only_on, only: [...next.only], prefer: [...next.prefer], beta: next.beta };
        set({ rules: wanted, saving: true, error: null });
        writes = writes.then(async () => {
          try {
            confirmed = fullSettings(await saveSearchSettings(client, wanted));
            if (version === revision) {
              set({ rules: confirmed, saving: false });
              searchSettingsChanged();
            }
          } catch (e) {
            if (version === revision) {
              set({ rules: confirmed, saving: false, error: errorText(e) });
              searchSettingsChanged();
            }
          }
        });
        await writes;
      },
    }));
    stores.set(client, store);
  }
  return store;
}

export function useSearchSettings<T>(client: KbClient, pick: (s: SearchSettingsState) => T): T {
  return useStore(searchSettingsStore(client), pick);
}
