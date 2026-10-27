import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbPageRef, KbRef } from '../../api/kb/types.gen';
import { errorText, type KbClient } from '../api/client';
import {
  chatSearchRules, resetChatSearchRules, saveChatSearchRules,
  type KbChatSearchRules, type KbSourceRef,
} from '../api/searchRules';
import { useServices } from '../state/context';
import { Button, Icon, IconButton, Segmented, Switch } from '../ui';
import { full, SEARCH_SETTINGS_CHANGED, SiteList, searchSettingsChanged, searchSettingsStore, type WebRules } from './sites';

/**
 * N7 · «Search & sources» of one chat, from the message field (no separate window, decision 2 revised):
 * a button in the field's bar opens a panel above it. It starts from Settings → Search; the chat may
 * pick its library sources (All / Only these, and what is excluded) and change its web lists (Only
 * these sites, Never — adding only, Prefer). Reset to Settings · Save as global (web lists only) · Save.
 * The button shows when the chat differs («Only these · 4»); clicking it turns the globe once.
 */

/** Ask the panel of a chat to open (the chat overview's «Edit»). */
export const OPEN_SEARCH_PANEL = 'kb:search-panel';
export function openSearchPanel(chatId: string) {
  window.dispatchEvent(new CustomEvent(OPEN_SEARCH_PANEL, { detail: { chatId } }));
}
/** The chat's rules changed (the panel saved; the overview excluded something): readers load them again. */
export const SEARCH_RULES_CHANGED = 'kb:search-rules-changed';
export function searchRulesChanged(chatId: string) {
  window.dispatchEvent(new CustomEvent(SEARCH_RULES_CHANGED, { detail: { chatId } }));
}

/**
 * The chat's rules, shared by every reader of one window (the button, the overview, each answer's
 * check) — one request per chat, again after a change from the panel or the overview.
 */
const ruleCaches = new WeakMap<KbClient, StoreApi<Record<string, KbChatSearchRules | null>>>();
const inflight = new WeakMap<KbClient, Map<string, Promise<void>>>();

function cacheOf(client: KbClient) {
  let store = ruleCaches.get(client);
  if (!store) {
    store = createStore<Record<string, KbChatSearchRules | null>>(() => ({}));
    ruleCaches.set(client, store);
    inflight.set(client, new Map());
  }
  return store;
}

function loadRules(client: KbClient, chatId: string, force = false): void {
  const store = cacheOf(client);
  const running = inflight.get(client)!;
  if (running.has(chatId) || (!force && chatId in store.getState())) return;
  const job = chatSearchRules(client, chatId).then(
    (rules) => store.setState({ [chatId]: rules }),
    () => store.setState({ [chatId]: null }),
  ).finally(() => running.delete(chatId));
  running.set(chatId, job);
}

export function useChatSearchRules(chatId: string | null): [KbChatSearchRules | null, (next: KbChatSearchRules) => void] {
  const { client } = useServices();
  const store = cacheOf(client);
  const rules = useStore(store, (s) => (chatId ? s[chatId] ?? null : null));
  useEffect(() => {
    if (!chatId) return undefined;
    loadRules(client, chatId);
    const changed = (e: Event) => { if ((e as CustomEvent<{ chatId: string }>).detail?.chatId === chatId) loadRules(client, chatId, true); };
    const settings = () => loadRules(client, chatId, true);
    window.addEventListener(SEARCH_RULES_CHANGED, changed);
    window.addEventListener(SEARCH_SETTINGS_CHANGED, settings);
    return () => {
      window.removeEventListener(SEARCH_RULES_CHANGED, changed);
      window.removeEventListener(SEARCH_SETTINGS_CHANGED, settings);
    };
  }, [client, chatId]);
  const set = useCallback((next: KbChatSearchRules) => { if (chatId) store.setState({ [chatId]: next }); }, [store, chatId]);
  return [rules, set];
}

interface Draft {
  web: WebRules;
  sourcesOnly: boolean;
  sources: KbSourceRef[];
  excluded: KbSourceRef[];
}

function draftOf(rules: KbChatSearchRules): Draft {
  const settings = full(rules.settings);
  const own = rules.web ? full(rules.web) : null;
  return {
    web: own ?? { ...settings, never: [] },
    sourcesOnly: rules.sources_only,
    sources: rules.sources,
    excluded: rules.excluded,
  };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
function webDiffers(draft: WebRules, settings: WebRules): boolean {
  return draft.never.length > 0 || draft.only_on !== settings.only_on || !sameList(draft.only, settings.only) || !sameList(draft.prefer, settings.prefer);
}

export function ChatSearchButton({ chatId }: { chatId: string }) {
  const [rules, setRules] = useChatSearchRules(chatId);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState(0);
  const button = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const ask = (e: Event) => {
      if ((e as CustomEvent<{ chatId: string }>).detail?.chatId !== chatId) return;
      setOpen(true);
    };
    window.addEventListener(OPEN_SEARCH_PANEL, ask);
    return () => window.removeEventListener(OPEN_SEARCH_PANEL, ask);
  }, [chatId]);
  useEffect(() => { setOpen(false); }, [chatId]);

  // Named without «sources»: the answer's own «Sources» buttons keep their name to themselves.
  const name = rules?.label ? `Search rules for this chat: ${rules.label}` : 'Search rules for this chat';
  return (
    <>
      <button ref={button} type="button" className="kb-sbtn" aria-label={name} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => { setTurns((n) => n + 1); setOpen((v) => !v); }}>
        <Icon name="web" size={16} play={turns} />
        {rules?.label && <span className="kb-sbtn__label">{rules.label}</span>}
      </button>
      {open && rules && (
        <SearchPanel chatId={chatId} rules={rules} onSaved={(next) => { setRules(next); searchRulesChanged(chatId); }}
          onClose={() => { setOpen(false); button.current?.focus(); }} />
      )}
    </>
  );
}

function SearchPanel({ chatId, rules, onSaved, onClose }: {
  chatId: string; rules: KbChatSearchRules; onSaved: (rules: KbChatSearchRules) => void; onClose: () => void;
}) {
  const { client } = useServices();
  const [draft, setDraft] = useState<Draft>(() => draftOf(rules));
  /** Q1 n78 M-8: the web lists are sent only when the user touched them (or the chat has its own) —
   *  never a copy of Settings that would pin them on the chat. */
  const [webTouched, setWebTouched] = useState(false);
  const [busy, setBusy] = useState<'save' | 'global' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setDraft(draftOf(rules)); }, [rules]);
  useEffect(() => { panel.current?.focus(); }, []);

  const settings = full(rules.settings);
  const changed = draft.sourcesOnly || draft.excluded.length > 0 || webDiffers(draft.web, settings);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setWeb = (patch: Partial<WebRules>) => {
    setWebTouched(true);
    setDraft((d) => ({ ...d, web: { ...d.web, ...patch } }));
  };

  const run = useCallback(async (kind: 'save' | 'global' | 'reset') => {
    setBusy(kind);
    setError(null);
    try {
      const next = kind === 'reset'
        ? await resetChatSearchRules(client, chatId)
        : await saveChatSearchRules(client, chatId, {
          web: webTouched || rules.web || kind === 'global' ? draft.web : null, sources_only: draft.sourcesOnly, sources: draft.sources.map((s) => s.id),
          excluded: draft.excluded.map((s) => s.id), as_global: kind === 'global',
        });
      onSaved(next);
      if (kind === 'global') {
        void searchSettingsStore(client).getState().load();
        searchSettingsChanged();
      }
      if (kind !== 'reset') onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [client, chatId, draft, webTouched, rules.web, onSaved, onClose]);

  return (
    <div ref={panel} className="kb-spanel" role="dialog" aria-label="Search and sources for this chat" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <div className="kb-spanel__head">
        Search &amp; sources<span className="kb-muted">· this chat</span>
        <span className="kb-spanel__spacer" />
        {changed && <span className="kb-spanel__changed">changed</span>}
        <IconButton icon="close" size="sm" label="Close" onClick={onClose} />
      </div>
      <div className="kb-spanel__body">
        <section className="kb-spanel__group" aria-label="Library">
          <h4 className="kb-spanel__title">Library</h4>
          <Segmented<'all' | 'only'> label="Library sources" size="sm" value={draft.sourcesOnly ? 'only' : 'all'}
            onChange={(v) => set({ sourcesOnly: v === 'only' })}
            options={[{ value: 'all', label: 'All sources' }, { value: 'only', label: 'Only these' }]} />
          {draft.sourcesOnly && (
            <>
              <ul className="kb-srcs" aria-label="Only these sources">
                {draft.sources.map((s) => (
                  <li key={s.id} className="kb-src">
                    <Icon name={s.kind === 'page' ? 'wiki' : 'text'} size={12} />
                    <span className="kb-src__name" title={s.title ?? s.id}>{s.title ?? 'No longer in the library'}</span>
                    <button type="button" className="kb-site__remove" aria-label={`Remove ${s.title ?? s.id}`}
                      onClick={() => set({ sources: draft.sources.filter((x) => x.id !== s.id) })}><Icon name="close" size={11} /></button>
                  </li>
                ))}
                <li><SourcePicker taken={[...draft.sources, ...draft.excluded].map((s) => s.id)}
                  onPick={(s) => set({ sources: [...draft.sources, s] })} /></li>
              </ul>
              <p className="kb-spanel__note">The agent gets only these from your library. Statements without one of them are counted under the answer.</p>
            </>
          )}
          {draft.excluded.length > 0 && (
            <>
              <ul className="kb-srcs" aria-label="Excluded from this chat">
                {draft.excluded.map((s) => (
                  <li key={s.id} className="kb-src is-out">
                    <span className="kb-src__name" title={s.title ?? s.id}>{s.title ?? 'No longer in the library'}</span>
                    <button type="button" className="kb-site__remove" aria-label={`Bring back ${s.title ?? s.id}`}
                      onClick={() => set({ excluded: draft.excluded.filter((x) => x.id !== s.id) })}><Icon name="close" size={11} /></button>
                  </li>
                ))}
              </ul>
              <p className="kb-spanel__note">Excluded from this chat: the agent doesn’t get them.</p>
            </>
          )}
          {!draft.sourcesOnly && draft.excluded.length === 0 && (
            <p className="kb-spanel__note">Exclude a material from the chat overview, or pick «Only these».</p>
          )}
        </section>
        <section className="kb-spanel__group" aria-label="Web · only these sites">
          <h4 className="kb-spanel__title">Web · only these sites
            <Switch label="Web · only these sites" checked={draft.web.only_on} onChange={(on) => setWeb({ only_on: on })} />
          </h4>
          <SiteList label="Only these sites" sites={draft.web.only} dim={!draft.web.only_on} onChange={(only) => setWeb({ only })} />
        </section>
        <section className="kb-spanel__group" aria-label="Never search">
          <h4 className="kb-spanel__title">Never search</h4>
          <SiteList label="Never search" sites={draft.web.never} inherited={settings.never} onChange={(never) => setWeb({ never })} />
        </section>
        <section className="kb-spanel__group" aria-label="Prefer">
          <h4 className="kb-spanel__title">Prefer</h4>
          <SiteList label="Prefer" sites={draft.web.prefer} onChange={(prefer) => setWeb({ prefer })} />
        </section>
        <p className="kb-spanel__note">Sites from Settings are dashed; a chat can add to them but not remove the blocked ones.</p>
        {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
      </div>
      <div className="kb-spanel__foot">
        <button type="button" className="kb-spanel__reset" disabled={!!busy} onClick={() => void run('reset')}>Reset to Settings</button>
        <span className="kb-spanel__spacer" />
        <Button size="sm" busy={busy === 'global'} disabled={!!busy} onClick={() => void run('global')}>Save as global</Button>
        <Button size="sm" variant="fill" busy={busy === 'save'} disabled={!!busy} onClick={() => void run('save')}>Save</Button>
      </div>
    </div>
  );
}

/** «Add material»: a material or wiki page by name (the same lookup as @-mentions). */
function SourcePicker({ taken, onPick }: { taken: readonly string[]; onPick: (source: KbSourceRef) => void }) {
  const { client } = useServices();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<KbSourceRef[]>([]);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const timer = window.setTimeout(() => {
      client.call('GET /kb/mentions', { query: { q: q.trim(), limit: 8 } }).then((res) => {
        if (!live) return;
        const materials = res.materials.map((m: KbRef) => ({ id: m.id, kind: 'material' as const, title: m.title }));
        const pages = res.pages.map((p: KbPageRef) => ({ id: p.id, kind: 'page' as const, title: p.title }));
        setFound([...materials, ...pages].filter((s) => !taken.includes(s.id)));
      }, () => { if (live) setFound([]); });
    }, 120);
    return () => { live = false; window.clearTimeout(timer); };
  }, [client, open, q, taken]);

  if (!open) {
    return <button type="button" className="kb-site-add" onClick={() => setOpen(true)}><Icon name="plus" size={12} />Add material</button>;
  }
  return (
    <span className="kb-src-pick">
      <input ref={input} className="kb-site-input" aria-label="Find a material or wiki page" placeholder="Material or page" value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); setQ(''); } }} />
      {found.length > 0 && (
        <ul className="kb-src-pick__list" aria-label="Materials and pages">
          {found.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => { onPick(s); setOpen(false); setQ(''); }}>
                <Icon name={s.kind === 'page' ? 'wiki' : 'text'} size={12} />{s.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
