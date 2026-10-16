import { useEffect, useId, useRef, useState } from 'react';
import type { KbPageSummary, KbSnippetPart } from '../../api/kb/types.gen';
import type { PageKind } from '../api/names';
import { Banner, Button, EmptyState, Icon, Spinner } from '../ui';
import { PAGE_KIND_ICON } from '../document/parts';
import { useLoad } from '../document/useLoad';
import { useLibrary, useServices, useUi } from '../state/context';
import type { WikiFileName } from '../state/document';
import { errorText } from '../api/client';
import { Snippet } from '../ui/Highlight';
import { SelectionCheckbox, type ListSelection } from '../ui/listSelection';
import { usePageSelection } from './pageBatch';
import type { DragRowProps } from '../materials/materialBatch';

interface Hit {
  key: string;
  pageId: string;
  blockId: string | null;
  kind: PageKind;
  title: string;
  snippet: KbSnippetPart[] | null;
}

/**
 * The wiki panel's search (B20): pages by title or alias first, then pages by text (the index's
 * FTS matches, one row per page with the first matching passage). ↑/↓ move, Enter opens, Esc
 * clears; the field keeps focus while the list is browsed.
 */
function WikiSearch() {
  const { client } = useServices();
  const openDocument = useUi((s) => s.openDocument);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const q = query.trim();

  useEffect(() => {
    if (!q) { setHits(null); setError(null); return undefined; }
    let live = true;
    const timer = window.setTimeout(() => {
      client.call('GET /kb/search', { query: { q, limit: 20 } }).then((r) => {
        if (!live) return;
        const out: Hit[] = [];
        const seen = new Set<string>();
        for (const p of r.pages) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          out.push({ key: `p-${p.id}`, pageId: p.id, blockId: null, kind: p.kind, title: p.title,
            snippet: p.matched_alias ? [{ text: p.matched_alias, match: true }] : null });
        }
        for (const b of r.blocks) {
          if (seen.has(b.page_id)) continue;
          seen.add(b.page_id);
          out.push({ key: `b-${b.page_id}`, pageId: b.page_id, blockId: b.block_id, kind: b.page_kind, title: b.page_title, snippet: b.snippet });
        }
        setHits(out);
        setActive(0);
        setError(null);
      }, (e: unknown) => { if (live) { setHits([]); setError(errorText(e)); } });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [client, q]);

  const open = (hit: Hit) => openDocument({ type: 'page', id: hit.pageId, block_id: hit.blockId });
  const list = hits ?? [];
  return (
    <div className="kb-wsearch">
      <div className="kb-settings__search kb-wsearch__field">
        <Icon name="search" size={14} />
        <input ref={inputRef} type="search" placeholder="Search the wiki" aria-label="Search the wiki" value={query}
          role="combobox" aria-expanded={hits !== null} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={hits && list[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setActive((i) => (i + 1) % list.length); }
            else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); setActive((i) => (i - 1 + list.length) % list.length); }
            else if (e.key === 'Enter' && list[active]) { e.preventDefault(); open(list[active]!); }
            else if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
          }} />
      </div>
      {hits !== null && (
        <>
          <ul className="kb-list kb-wsearch__list" id={listId} role="listbox" aria-label="Wiki pages found">
            {list.map((hit, i) => (
              <li key={hit.key} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                className={`kb-row kb-wsearch__hit${i === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => open(hit)}>
                <Icon name={PAGE_KIND_ICON[hit.kind]} size={16} className="kb-row__icon" />
                <span className="kb-row__text">
                  <span className="kb-wsearch__title">{hit.title}</span>
                  {hit.snippet && <span className="kb-wsearch__snippet"><Snippet parts={hit.snippet} /></span>}
                </span>
              </li>
            ))}
          </ul>
          <p className={error ? 'kb-inline-error kb-inline-error--flat' : 'kb-side__note'} role="status">
            {error ?? (list.length === 0 ? `No pages match “${q}”.` : list.length === 1 ? '1 page' : `${list.length} pages`)}
          </p>
        </>
      )}
    </div>
  );
}

const FILES: ReadonlyArray<{ name: WikiFileName; label: string }> = [
  { name: 'index', label: 'Index' },
  { name: 'log', label: 'Log' },
];

const SECTIONS: ReadonlyArray<{ kind: PageKind; label: string }> = [
  { kind: 'concept', label: 'Concepts' },
  { kind: 'note', label: 'Notes' },
  { kind: 'analysis', label: 'Analyses' },
  { kind: 'folder', label: 'Folder overviews' },
];

/** How pages of each kind appear, said where the list is empty (QA C24). */
const EMPTY_HINT: Record<PageKind, string> = {
  concept: 'Concepts appear as materials are added to the wiki.',
  note: 'Each material added to the wiki gets its notes here.',
  analysis: 'Save a chat answer to the wiki (“Save to wiki” under the answer) to keep it here.',
  folder: 'A folder gets its overview once its materials are in the wiki.',
};

function PageRow({ page, sel, drag }: { page: KbPageSummary; sel: ListSelection; drag: DragRowProps }) {
  const openDocument = useUi((s) => s.openDocument);
  const current = useUi((s) => s.right?.kind === 'doc' && s.right.target.type === 'page' && s.right.target.id === page.id);
  return (
    <li {...sel.rowProps(page.id)} {...drag}>
      <div role="gridcell">
        <button type="button" className={`kb-row${current ? ' is-current' : ''}`} aria-current={current ? 'true' : undefined}
          onClick={() => openDocument({ type: 'page', id: page.id })}>
          <SelectionCheckbox checked={sel.selected.has(page.id)} />
          <Icon name={PAGE_KIND_ICON[page.kind]} size={16} className="kb-row__icon" />
          <span className="kb-row__text">{page.title}</span>
        </button>
      </div>
    </li>
  );
}

/** Pages that can be selected several at once (0.3.1 F4): compact bar, ⌘/ keys, drag to the chat field. */
function PageList({ pages, labelledBy, resetKey }: { pages: KbPageSummary[]; labelledBy: string; resetKey?: unknown }) {
  const openDocument = useUi((s) => s.openDocument);
  const { sel, overlays, dragProps } = usePageSelection({ pages, resetKey, onOpen: (id) => openDocument({ type: 'page', id }) });
  return (
    <div className="kb-sellist" {...sel.listProps}>
      <ul className="kb-list" {...sel.gridProps} aria-labelledby={labelledBy}>
        {pages.map((p) => <PageRow key={p.id} page={p} sel={sel} drag={dragProps(p)} />)}
      </ul>
      {overlays}
    </div>
  );
}

/** Side panel "Wiki" (v39): sections with counts, the graph, recently opened pages. */
export function WikiSide() {
  const { client } = useServices();
  const openGraph = useUi((s) => s.openGraph);
  const graphOpen = useUi((s) => s.right?.kind === 'graph');
  const recent = useUi((s) => s.recentPages);
  const openWikiFile = useUi((s) => s.openWikiFile);
  const fileOpen = useUi((s) => (s.right?.kind === 'wikifile' ? s.right.name : null));
  const [kind, setKind] = useState<PageKind | null>(null);
  const { state, reload } = useLoad('wiki-pages', () => client.call('GET /kb/wiki/pages'));
  // A page renamed or deleted (or anything else that reloads the library) shows here too.
  const revision = useLibrary((s) => s.revision);
  const seen = useRef(revision);
  useEffect(() => { if (seen.current !== revision) { seen.current = revision; reload(); } }, [revision, reload]);
  const pages = state.value ?? [];
  const byId = new Map(pages.map((p) => [p.id, p]));

  if (state.load === 'loading' && !state.value) return <div className="kb-side__wait"><Spinner label="Reading the wiki" /></div>;
  if (state.load === 'error' && !state.value) {
    return (
      <div className="kb-side__pad">
        <Banner tone="error" title="Couldn’t read the wiki." actions={<Button size="sm" icon="retry" onClick={reload}>Try again</Button>}>{state.error}</Banner>
      </div>
    );
  }

  if (kind) {
    const list = pages.filter((p) => p.kind === kind).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    const label = SECTIONS.find((s) => s.kind === kind)!.label;
    return (
      <div className="kb-side__scroll">
        <button type="button" className="kb-row kb-row--back" onClick={() => setKind(null)}>
          <Icon name="chevronLeft" size={16} className="kb-row__icon" />
          <span className="kb-row__text">Wiki</span>
        </button>
        <h3 className="kb-subhead kb-subhead--folder" id="kb-wiki-kind"><Icon name={PAGE_KIND_ICON[kind]} size={14} /><span className="kb-subhead__text">{label}</span></h3>
        {list.length === 0 ? (
          <EmptyState icon="wiki" title={`No ${label.toLowerCase()} yet`} compact>{EMPTY_HINT[kind]}</EmptyState>
        ) : (
          <PageList pages={list} labelledBy="kb-wiki-kind" resetKey={kind} />
        )}
      </div>
    );
  }

  const recentPages = recent.map((id) => byId.get(id)).filter((p): p is KbPageSummary => Boolean(p));
  return (
    <div className="kb-side__scroll">
      <WikiSearch />
      <h3 className="kb-subhead" id="kb-wiki-sections">Sections</h3>
      <ul className="kb-list" aria-labelledby="kb-wiki-sections">
        {SECTIONS.map((s) => {
          const n = pages.filter((p) => p.kind === s.kind).length;
          return (
            <li key={s.kind}>
              <button type="button" className="kb-row" onClick={() => setKind(s.kind)}>
                <Icon name={PAGE_KIND_ICON[s.kind]} size={16} className="kb-row__icon" />
                <span className="kb-row__text">{s.label}</span>
                <span className="kb-row__count">{n}</span>
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className={`kb-row${graphOpen ? ' is-current' : ''}`} onClick={() => openGraph()} aria-current={graphOpen ? 'true' : undefined}>
            <Icon name="graph" size={16} className="kb-row__icon" />
            <span className="kb-row__text">Graph of connections</span>
          </button>
        </li>
        {FILES.map((f) => (
          <li key={f.name}>
            <button type="button" className={`kb-row${fileOpen === f.name ? ' is-current' : ''}`} aria-current={fileOpen === f.name ? 'true' : undefined}
              title="SKAZ keeps Index and Log — they can’t be selected" onClick={() => openWikiFile(f.name)}>
              <Icon name="text" size={16} className="kb-row__icon" />
              <span className="kb-row__text">{f.label}</span>
            </button>
          </li>
        ))}
      </ul>
      {recentPages.length > 0 && (
        <>
          <h3 className="kb-subhead" id="kb-wiki-recent">Recently opened</h3>
          <PageList pages={recentPages} labelledBy="kb-wiki-recent" />
        </>
      )}
      {pages.length === 0 && (
        <EmptyState icon="wiki" title="The wiki is empty" compact>
          Concepts, notes and analyses appear as materials are added to the wiki.
        </EmptyState>
      )}
    </div>
  );
}

/** Side panel "Graph": the graph opens on the right; here — the way back to it. */
export function GraphSide() {
  const openGraph = useUi((s) => s.openGraph);
  const graphOpen = useUi((s) => s.right?.kind === 'graph');
  return (
    <div className="kb-side__scroll">
      <button type="button" className={`kb-row kb-row--action${graphOpen ? ' is-current' : ''}`} onClick={() => openGraph()}>
        <Icon name="graph" size={16} className="kb-row__icon" />
        <span className="kb-row__text">{graphOpen ? 'Graph is open' : 'Open the graph'}</span>
      </button>
      <p className="kb-side__note">How concepts connect across your folders. Colour is the folder; rings mean a concept lives in several folders; dashed lines cross folders.</p>
    </div>
  );
}
