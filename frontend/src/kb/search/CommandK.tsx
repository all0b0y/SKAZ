import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { KbChatSummary, KbSearchResults } from '../api/b2';
import { errorText } from '../api/client';
import { Icon, Modal, type IconName } from '../ui';
import { Highlight, Snippet } from '../ui/Highlight';
import { clock, shortTime } from '../ui/time';
import { useServices, useUi } from '../state/context';
import type { DocRef } from '../state/document';

export type Tab = 'all' | 'wiki' | 'materials' | 'chats';

export interface Hit {
  key: string;
  section: Exclude<Tab, 'all'>;
  icon: IconName;
  title: string;
  snippet: KbSearchResults['blocks'][number]['snippet'] | null;
  meta: string;
  open: { doc: DocRef } | { chat: string };
}

const PAGE_ICON: Record<string, IconName> = { concept: 'concept', note: 'note', analysis: 'analysis', folder: 'folder' };
const PAGE_KIND: Record<string, string> = { concept: 'concept', note: 'notes', analysis: 'analysis', folder: 'folder overview' };
const MAT_ICON: Record<string, IconName> = {
  recording: 'mic', audio: 'audio', video: 'video', video_link: 'video', pdf: 'pdf', book: 'pdf', web: 'link', text: 'text',
};

/** Wiki · Materials · Chats hits in one list; a page hit and its blocks are one row. */
export function toHits(res: KbSearchResults | null, chats: KbChatSummary[] | null): Hit[] {
  const out: Hit[] = [];
  if (res) {
    const pages = new Set<string>();
    for (const p of res.pages) {
      pages.add(p.id);
      out.push({ key: `p-${p.id}`, section: 'wiki', icon: PAGE_ICON[p.kind] ?? 'wiki', title: p.title, snippet: null,
        meta: [PAGE_KIND[p.kind], p.matched_alias ? `also “${p.matched_alias}”` : ''].filter(Boolean).join(' · '),
        open: { doc: { type: 'page', id: p.id } } });
    }
    for (const b of res.blocks) {
      if (pages.has(b.page_id)) continue;
      pages.add(b.page_id);
      out.push({ key: `b-${b.page_id}-${b.block_id}`, section: 'wiki', icon: PAGE_ICON[b.page_kind] ?? 'wiki', title: b.page_title, snippet: b.snippet,
        meta: PAGE_KIND[b.page_kind] ?? 'page', open: { doc: { type: 'page', id: b.page_id, block_id: b.block_id } } });
    }
    const mats = new Set<string>();
    for (const m of res.materials ?? []) {
      mats.add(m.id);
      out.push({ key: `m-${m.id}`, section: 'materials', icon: MAT_ICON[m.kind] ?? 'pdf', title: m.title, snippet: null,
        meta: m.folder_name, open: { doc: { type: 'material', id: m.id } } });
    }
    for (const f of res.fragments) {
      const key = `f-${f.material_id}-${f.seg}`;
      if (mats.has(f.material_id)) continue;
      mats.add(f.material_id);
      out.push({ key, section: 'materials', icon: MAT_ICON[f.material_kind] ?? 'pdf', title: f.material_title, snippet: f.snippet,
        meta: f.start_ms !== null ? clock(f.start_ms) : f.page !== null ? `p. ${f.page}` : '', open: { doc: { type: 'material', id: f.material_id, seg: f.seg } } });
    }
  }
  for (const c of chats ?? []) {
    out.push({ key: `c-${c.id}`, section: 'chats', icon: 'chats', title: c.title, snippet: c.last_preview ? [{ text: c.last_preview, match: false }] : null,
      meta: [c.pinned ? 'pinned' : '', shortTime(c.updated_at)].filter(Boolean).join(' · '), open: { chat: c.id } });
  }
  return out;
}

const SECTION_LABEL: Record<Exclude<Tab, 'all'>, string> = { wiki: 'Wiki', materials: 'Materials', chats: 'Chats' };
const TABS: Tab[] = ['all', 'wiki', 'materials', 'chats'];
const PER_SECTION = 3;

/**
 * ⌘K (decision 29, v16): modal at the top; All / Wiki / Materials / Chats with counts, three per
 * section in "All"; matches highlighted; Enter opens, ⌘Enter asks the agent; "Ask agent" is the
 * last row. Searches `/kb/search` and `/kb/chats?q=` together.
 */
export function CommandK() {
  const { client, ui, chats, composer } = useServices();
  const open = useUi((s) => s.searchOpen);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [res, setRes] = useState<KbSearchResults | null>(null);
  const [chatHits, setChatHits] = useState<KbChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) { setQ(''); setTab('all'); setRes(null); setChatHits(null); setError(null); setActive(0); }
  }, [open]);

  useEffect(() => {
    const query = q.trim();
    if (!open || !query) { setRes(null); setChatHits(null); setLoading(false); return undefined; }
    let live = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      Promise.allSettled([
        client.call('GET /kb/search', { query: { q: query, limit: 20 } }),
        client.call('GET /kb/chats', { query: { q: query, limit: 20 } }),
      ]).then(([s, c]) => {
        if (!live) return;
        setRes(s.status === 'fulfilled' ? s.value : null);
        setChatHits(c.status === 'fulfilled' ? c.value : null);
        const failed = [s, c].filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
        setError(failed.length ? errorText(failed[0]!.reason) : null);
        setLoading(false);
        setActive(0);
      });
    }, 150);
    return () => { live = false; window.clearTimeout(t); };
  }, [client, q, open]);

  const hits = useMemo(() => toHits(res, chatHits), [res, chatHits]);
  const counts: Record<Tab, number> = {
    wiki: res?.counts?.wiki ?? hits.filter((h) => h.section === 'wiki').length,
    materials: res?.counts?.materials ?? hits.filter((h) => h.section === 'materials').length,
    chats: chatHits?.length ?? 0,
    all: 0,
  };
  counts.all = counts.wiki + counts.materials + counts.chats;
  const shown = tab === 'all'
    ? (['wiki', 'materials', 'chats'] as const).flatMap((s) => hits.filter((h) => h.section === s).slice(0, PER_SECTION))
    : hits.filter((h) => h.section === tab);
  const query = q.trim();
  const rows = query ? shown.length + 1 : 0; // + "Ask agent"

  const close = () => ui.getState().setSearchOpen(false);
  const openHit = (hit: Hit) => {
    close();
    if ('chat' in hit.open) {
      chats.getState().open(hit.open.chat);
      ui.getState().setCenterView('chat');
    } else {
      ui.getState().openDocument(hit.open.doc);
    }
  };
  const ask = () => {
    if (!query) return;
    close();
    chats.getState().open(null);
    ui.getState().setCenterView('chat');
    composer.getState().push([{ kind: 'text', text: query }], { focus: true, send: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' && rows) { event.preventDefault(); setActive((i) => (i + 1) % rows); }
    else if (event.key === 'ArrowUp' && rows) { event.preventDefault(); setActive((i) => (i - 1 + rows) % rows); }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); ask(); }
    else if (event.key === 'Enter' && rows) {
      event.preventDefault();
      const hit = shown[active];
      if (hit) openHit(hit); else ask();
    } else if (event.key === 'Tab' && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      const i = TABS.indexOf(tab);
      setTab(TABS[(i + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length]!);
      setActive(0);
    }
  };

  let lastSection = '';
  return (
    <Modal open={open} onClose={close} title="Search" bare className="kb-search" testId="search" pane="search" initialFocusRef={inputRef}>
      <div className="kb-search__wrap" onKeyDown={onKeyDown}>
        <div className="kb-search__field">
          <Icon name="search" size={16} />
          <input ref={inputRef} className="kb-search__input" type="text" role="combobox" aria-expanded={rows > 0} aria-controls={listId}
            aria-activedescendant={rows ? `${listId}-${active}` : undefined} aria-label="Search the wiki, materials and chats"
            placeholder="Search the wiki, materials and chats" value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd className="kb-kbd">esc</kbd>
        </div>
        <div className="kb-search__tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} tabIndex={-1} className={`kb-search__tab${tab === t ? ' is-on' : ''}`}
              onClick={() => { setTab(t); setActive(0); inputRef.current?.focus(); }}>
              {t === 'all' ? 'All' : SECTION_LABEL[t]}{query && <span className="kb-search__count">{counts[t]}</span>}
            </button>
          ))}
        </div>
        <div className="kb-search__results">
          {!query && <p className="kb-search__hint">Type to search. Enter opens, ⌘Enter asks the agent.</p>}
          {query && error && <p className="kb-inline-error kb-inline-error--flat" role="alert">Search: {error}</p>}
          {query && !loading && shown.length === 0 && !error && <p className="kb-search__hint">Nothing found for “{query}”.</p>}
          <ul id={listId} role="listbox" aria-label="Results" className="kb-search__list">
            {shown.map((h, i) => {
              const head = tab === 'all' && h.section !== lastSection ? h.section : null;
              lastSection = h.section;
              return (
                <li key={h.key} role="presentation">
                  {head && (
                    <div className="kb-search__section" role="presentation">
                      <span>{SECTION_LABEL[head]}</span>
                      <button type="button" tabIndex={-1} className="kb-search__all" onClick={() => { setTab(head); setActive(0); inputRef.current?.focus(); }}>
                        all <Icon name="chevronRight" size={12} />
                      </button>
                    </div>
                  )}
                  <div id={`${listId}-${i}`} role="option" aria-selected={i === active} className={`kb-search__row${i === active ? ' is-active' : ''}`}
                    onMouseEnter={() => setActive(i)} onClick={() => openHit(h)}>
                    <span className="kb-search__icon" aria-hidden="true"><Icon name={h.icon} size={14} /></span>
                    <span className="kb-search__main">
                      <span className="kb-search__title"><Highlight text={h.title} query={query} /></span>
                      {h.snippet && <span className="kb-search__snippet"><Snippet parts={h.snippet} /></span>}
                    </span>
                    <span className="kb-search__meta">{h.meta}</span>
                  </div>
                </li>
              );
            })}
            {query && (
              <li role="presentation">
                <div id={`${listId}-${shown.length}`} role="option" aria-selected={active === shown.length}
                  className={`kb-search__row kb-search__row--ask${active === shown.length ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(shown.length)} onClick={ask}>
                  <span className="kb-search__icon" aria-hidden="true"><Icon name="askAgent" size={14} /></span>
                  <span className="kb-search__main"><span className="kb-search__title">Ask the agent: “{query}”</span></span>
                  <kbd className="kb-kbd">⌘↵</kbd>
                </div>
              </li>
            )}
          </ul>
        </div>
        <footer className="kb-search__keys" aria-hidden="true">
          <span><kbd className="kb-kbd">↑↓</kbd>choose</span>
          <span><kbd className="kb-kbd">↵</kbd>open</span>
          <span><kbd className="kb-kbd">⌘↵</kbd>ask the agent</span>
          <span><kbd className="kb-kbd">⇥</kbd>section</span>
        </footer>
      </div>
    </Modal>
  );
}
