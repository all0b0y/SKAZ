import { useState } from 'react';
import type { KbPageSummary } from '../../api/kb/types.gen';
import type { PageKind } from '../api/b2-u3';
import { Banner, Button, EmptyState, Icon, Spinner } from '../ui';
import { PAGE_KIND_ICON } from '../document/parts';
import { useLoad } from '../document/useLoad';
import { useServices, useUi } from '../state/context';

const SECTIONS: ReadonlyArray<{ kind: PageKind; label: string }> = [
  { kind: 'concept', label: 'Concepts' },
  { kind: 'note', label: 'Notes' },
  { kind: 'analysis', label: 'Analyses' },
  { kind: 'folder', label: 'Folder overviews' },
];

function PageRow({ page }: { page: KbPageSummary }) {
  const openDocument = useUi((s) => s.openDocument);
  const current = useUi((s) => s.right?.kind === 'doc' && s.right.target.type === 'page' && s.right.target.id === page.id);
  return (
    <li>
      <button type="button" className={`kb-row${current ? ' is-current' : ''}`} aria-current={current ? 'true' : undefined}
        onClick={() => openDocument({ type: 'page', id: page.id })}>
        <Icon name={PAGE_KIND_ICON[page.kind]} size={16} className="kb-row__icon" />
        <span className="kb-row__text">{page.title}</span>
      </button>
    </li>
  );
}

/** Side panel "Wiki" (v39): sections with counts, the graph, recently opened pages. */
export function WikiSide() {
  const { u3 } = useServices();
  const openGraph = useUi((s) => s.openGraph);
  const graphOpen = useUi((s) => s.right?.kind === 'graph');
  const recent = useUi((s) => s.recentPages);
  const [kind, setKind] = useState<PageKind | null>(null);
  const { state, reload } = useLoad('wiki-pages', () => u3.call('GET /kb/wiki/pages'));
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
        {list.length === 0 ? <EmptyState icon="wiki" title={`No ${label.toLowerCase()} yet`} compact /> : (
          <ul className="kb-list" aria-labelledby="kb-wiki-kind">{list.map((p) => <PageRow key={p.id} page={p} />)}</ul>
        )}
      </div>
    );
  }

  const recentPages = recent.map((id) => byId.get(id)).filter((p): p is KbPageSummary => Boolean(p));
  return (
    <div className="kb-side__scroll">
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
          <button type="button" className={`kb-row${graphOpen ? ' is-current' : ''}`} onClick={openGraph} aria-current={graphOpen ? 'true' : undefined}>
            <Icon name="graph" size={16} className="kb-row__icon" />
            <span className="kb-row__text">Graph of connections</span>
          </button>
        </li>
      </ul>
      {recentPages.length > 0 && (
        <>
          <h3 className="kb-subhead" id="kb-wiki-recent">Recently opened</h3>
          <ul className="kb-list" aria-labelledby="kb-wiki-recent">{recentPages.map((p) => <PageRow key={p.id} page={p} />)}</ul>
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
      <button type="button" className={`kb-row kb-row--action${graphOpen ? ' is-current' : ''}`} onClick={openGraph}>
        <Icon name="graph" size={16} className="kb-row__icon" />
        <span className="kb-row__text">{graphOpen ? 'Graph is open' : 'Open the graph'}</span>
      </button>
      <p className="kb-side__note">How concepts connect across your folders. Colour is the folder; rings mean a concept lives in several folders; dashed lines cross folders.</p>
    </div>
  );
}
