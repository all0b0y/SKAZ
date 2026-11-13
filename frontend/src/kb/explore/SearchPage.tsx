import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KbFinding, KbSearch } from '../../api/kb/types.gen';
import type { ExploreClient } from '../api/explore';
import type { DocTarget } from '../state/document';
import type { SettingsSection } from '../state/ui';
import type { ToastData } from '../ui/Toast';
import { Button, Icon, Menu, type MenuItem } from '../ui';
import { exploreIssue } from './errors';
import {
  DEFAULT_FILTERS, SHOW_LABEL, SORT_LABEL, TYPE_LABEL, YEAR_LABEL, filtersActive, filtersQuery, readFilters, writeFilters,
  type FindingFilters,
} from './filters';
import { PaperReader } from './PaperReader';
import { STAGE_STEP } from './types';

type Toast = (toast: Omit<ToastData, 'id'>) => void;

const TYPE_TEXT: Record<string, string> = {
  preprint: 'Preprint', 'posted-content': 'Preprint', article: 'Journal article', 'journal-article': 'Journal article',
  'conference-paper': 'Conference paper', 'proceedings-article': 'Conference paper', review: 'Review',
  dissertation: 'Dissertation', 'book-chapter': 'Book chapter',
};

/** What a paused or failed search says, and what can be done about it. */
export const STOP_TEXT: Record<string, { text: string; settings?: boolean; resume?: string }> = {
  decision_model_required: { text: 'Set up a decision model to check which papers fit the topic.', settings: true },
  science_consent_required: { text: 'SKAZ needs your OK to send the topic words to OpenAlex. Turn it on in Settings, then continue.', settings: true, resume: 'Continue' },
  openalex_daily_limit: { text: "OpenAlex's free daily limit is reached. Continue tomorrow, or add a free key in Settings.", settings: true, resume: 'Continue' },
  budget: { text: 'Paused at the step limit of this search.', resume: 'Continue' },
  user_pause: { text: 'Paused.', resume: 'Continue' },
  app_exit: { text: 'Stopped when SKAZ closed. Free steps go on by themselves; paid checks wait for your Continue.', resume: 'Continue' },
  provider_unavailable: { text: "OpenAlex didn't answer.", resume: 'Try again' },
  failed: { text: 'This search failed.' },
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function authorsLine(f: KbFinding): string {
  const a = f.work.authors;
  return [a.slice(0, 3).join(', ') + (a.length > 3 ? ' et al.' : ''), f.work.publication.year, f.work.venue]
    .filter((x) => x !== null && x !== undefined && x !== '').join(' · ');
}

/** «The library has…» → «the library has…» — but a name or acronym (MoE, RAG, GPT-4) keeps its capitals. */
export function lowerFirst(text: string): string {
  const clean = text.replace(/\.$/, '');
  const word = clean.split(/\s/, 1)[0] ?? '';
  return /[A-Z]/.test(word.slice(1)) ? clean : clean.replace(/^./, (c) => c.toLowerCase());
}

const pageUrl = (f: KbFinding): string | null => f.read_url ?? (f.work.doi ? `https://doi.org/${f.work.doi}` : null);

export interface SearchPageProps {
  search: KbSearch;
  scopeName: string;
  explore: ExploreClient;
  parallelLimit: number;
  /** Something sits over the page (a menu, a dialog, the toast): the reader's native view steps aside. */
  covered: boolean;
  /** A menu of this page is open (true) or closed (false); it switches itself off when the page goes away. */
  onCovered: (covered: boolean) => void;
  onChanged: () => void;
  onDiscuss: (chatId: string) => void;
  onOpenDocument: (target: DocTarget) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  toast: Toast;
}

export function SearchPage(props: SearchPageProps) {
  const { search, explore, onChanged, onCovered, toast } = props;
  const [filters, setFiltersState] = useState<FindingFilters>(() => readFilters());
  const [rows, setRows] = useState<KbFinding[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** The paper being read. It is kept on its own: the list is filtered, and opening a paper changes its state. */
  const [open, setOpen] = useState<KbFinding | null>(null);
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => () => onCovered(false), [onCovered]);

  const setFilters = (next: FindingFilters) => { setFiltersState(next); writeFilters(next); };

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const res = await explore.search_findings(filtersQuery(search.id, filters));
      if (mine !== generation.current) return;
      setRows(res.groups.flatMap((g) => g.findings));
      setFailed(null);
    } catch (error) {
      if (mine === generation.current) setFailed(exploreIssue(error).message);
    }
  }, [explore, search.id, filters]);

  // New findings arrive while the search runs; a finished search is read once per change.
  useEffect(() => { void load(); }, [load, search.state, search.new, search.unseen]);

  const replace = (next: KbFinding) => {
    setRows((old) => old?.map((f) => (f.id === next.id ? next : f)) ?? old);
    setOpen((now) => (now && now.id === next.id ? next : now));
  };

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); } catch (error) { toast({ text: exploreIssue(error).message, tone: 'problem' }); } finally { setBusy(false); }
  };

  const openRow = (f: KbFinding) => {
    setOpen(f);
    if ((f.state ?? 'new') === 'new') {
      void explore.seen(f.id).then((next) => { replace(next); onChanged(); }).catch(() => undefined);
    }
  };

  const addToMaterials = (f: KbFinding) => act(async () => {
    const added = await explore.add_to_materials(f.id);
    replace({ ...f, state: 'materials', material_id: added.material_id ?? null });
    onChanged();
    toast({ text: 'Added to Materials › From Explore · not in the wiki yet', tone: 'done' });
  });

  const dismiss = (f: KbFinding) => act(async () => {
    const next = await explore.dismiss(f.id);
    if (filters.show === 'dismissed') replace(next); else setRows((old) => old?.filter((x) => x.id !== f.id) ?? old);
    if (open?.id === f.id) setOpen(null);
    onChanged();
    toast({ text: 'Hidden. Show → Not for me brings it back.', action: { label: 'Undo', run: () => void explore.restore(f.id).then(() => { void load(); onChanged(); }) } });
  });

  const restore = (f: KbFinding) => act(async () => {
    await explore.restore(f.id);
    setRows((old) => old?.filter((x) => x.id !== f.id) ?? old);
    if (open?.id === f.id) setOpen(null);
    onChanged();
  });

  const discuss = (f: KbFinding) => act(async () => {
    const talk = await explore.discuss(f.id);
    replace({ ...f, discuss_chat_id: talk.chat_id });
    props.onDiscuss(talk.chat_id);
  });

  const openInBrowser = (f: KbFinding) => {
    const url = pageUrl(f);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  const resume = () => act(async () => {
    if (!search.checkpoint_id || search.checkpoint_revision === null) return;
    await explore.resume(search.id, { checkpoint_id: search.checkpoint_id, revision: search.checkpoint_revision });
    onChanged();
  });
  const pause = () => act(async () => { await explore.pause(search.id); onChanged(); });

  return (
    <div className="kb-ex-search">
      <section className="kb-ex-list" aria-label="Papers found">
        <header className="kb-ex-list__head">
          <div className="kb-ex-list__title">
            <h2 title={search.name}>{search.name}</h2>
            {search.query && <span className="kb-ex-muted">in {props.scopeName}</span>}
          </div>
          <Progress search={search} limit={props.parallelLimit} steps={steps} onSteps={() => setSteps((s) => !s)}
            busy={busy} onResume={() => void resume()} onPause={() => void pause()} onOpenSettings={props.onOpenSettings} />
        </header>
        <Filters filters={filters} onChange={setFilters} onCovered={onCovered} />
        <div className="kb-ex-rows" role="list">
          {failed && <div className="kb-ex-empty" role="alert"><p>{failed}</p><Button size="sm" onClick={() => void load()}>Try again</Button></div>}
          {!failed && rows === null && <p className="kb-ex-muted kb-ex-pad" role="status">Loading…</p>}
          {!failed && rows !== null && rows.length === 0 && (
            <Empty search={search} filters={filters} onClear={() => setFilters({ ...DEFAULT_FILTERS, sort: filters.sort })}
              onShowPaid={() => setFilters({ ...filters, free: false })} />
          )}
          {rows?.map((f) => <Row key={f.id} f={f} open={f.id === open?.id} onOpen={() => openRow(f)} onRestore={() => void restore(f)} />)}
        </div>
      </section>
      <section className="kb-ex-reader" aria-label="Paper">
        {open ? <>
          <ReaderHead f={open} busy={busy} onClose={() => setOpen(null)} onAdd={() => void addToMaterials(open)}
            onDiscuss={() => void discuss(open)} onBrowser={() => openInBrowser(open)} onDismiss={() => void dismiss(open)}
            onRestore={() => void restore(open)} onOpenDocument={props.onOpenDocument} />
          <PaperReader url={pageUrl(open)} covered={props.covered} />
        </> : <div className="kb-ex-reader__empty">Pick a paper on the left — it opens here.</div>}
      </section>
    </div>
  );
}

function Progress({ search, limit, steps, onSteps, busy, onResume, onPause, onOpenSettings }: {
  search: KbSearch; limit: number; steps: boolean; onSteps: () => void; busy: boolean;
  onResume: () => void; onPause: () => void; onOpenSettings: (section?: SettingsSection) => void;
}) {
  if (search.state === 'queued') {
    return <p className="kb-ex-funnel">Waiting — {limit} searches are already running.</p>;
  }
  if (search.state === 'running') {
    const step = STAGE_STEP[search.stage as keyof typeof STAGE_STEP] ?? 1;
    return <div className="kb-ex-progress" role="status">
      <span>{search.found > 0 ? `${search.found} found · step ${step} of 5` : 'Searching OpenAlex…'}</span>
      <progress aria-label="Search progress" value={step} max={5} />
      <Button size="sm" variant="quiet" disabled={busy} onClick={onPause}>Stop</Button>
    </div>;
  }
  if (search.state === 'paused' || search.state === 'error') {
    const stop = STOP_TEXT[search.stop_reason ?? (search.state === 'error' ? 'failed' : 'user_pause')] ?? STOP_TEXT.user_pause!;
    return <div className="kb-ex-stop" role="alert">
      <span>{stop.text}</span>
      {stop.settings && <Button size="sm" onClick={() => onOpenSettings('search')}>Open Settings</Button>}
      {stop.resume && search.checkpoint_id && <Button size="sm" disabled={busy} onClick={onResume}>{stop.resume}</Button>}
    </div>;
  }
  const when = shortDate(search.updated_at);
  return <>
    <p className="kb-ex-funnel">
      {when && `${when} · `}{search.found} found → {search.fit} fit → {search.new} new{' '}
      <button type="button" className="kb-ex-link" aria-expanded={steps} onClick={onSteps}>{steps ? 'Hide steps' : 'Steps'}</button>
    </p>
    {steps && <dl className="kb-ex-steps">
      <dt>Found in OpenAlex</dt><dd>{search.found}</dd>
      <dt>Fit the topic</dt><dd>{search.fit}</dd>
      <dt>Readable (open text or a real abstract)</dt><dd>{Math.max(search.fit - search.no_text, 0)}{search.no_text > 0 && ` · dropped, no text: ${search.no_text}`}</dd>
      <dt>New for you (not already in your wiki)</dt><dd>{search.new}</dd>
    </dl>}
  </>;
}

function Empty({ search, filters, onClear, onShowPaid }: {
  search: KbSearch; filters: FindingFilters; onClear: () => void; onShowPaid: () => void;
}) {
  if (search.state === 'running' || search.state === 'queued') return <p className="kb-ex-muted kb-ex-pad">Papers appear here as they are checked.</p>;
  if (search.state === 'paused' || search.state === 'error') return <p className="kb-ex-muted kb-ex-pad">Nothing to show yet.</p>;
  if (search.found === 0) {
    return <div className="kb-ex-empty"><strong>Nothing found</strong><span className="kb-ex-muted">No papers came back for these words.</span></div>;
  }
  if (search.new === 0) {
    return <div className="kb-ex-empty"><strong>Nothing new for you</strong><span className="kb-ex-muted">
      {search.no_text > 0
        ? `Every paper that fit is already in your wiki, or had no text to read (${search.no_text}).`
        : 'Every paper that fit is already covered by your wiki.'}
    </span></div>;
  }
  return <div className="kb-ex-empty">
    <strong>Nothing matches the filters</strong>
    {filtersActive(filters) || !filters.free
      ? <Button size="sm" onClick={onClear}>Clear filters</Button>
      : <Button size="sm" onClick={onShowPaid}>Show paid papers too</Button>}
  </div>;
}

function Row({ f, open, onOpen, onRestore }: { f: KbFinding; open: boolean; onOpen: () => void; onRestore: () => void }) {
  const state = f.state ?? 'new';
  const meta = [f.work.publication.year, TYPE_TEXT[f.work.publication_type ?? ''] ?? 'Other', f.work.venue].filter(Boolean).join(' · ');
  return (
    <div role="listitem" className={`kb-ex-row${state === 'new' ? ' is-new' : ''}${open ? ' is-open' : ''}`}>
      <button type="button" className="kb-ex-row__main" aria-current={open || undefined} onClick={onOpen}>
        <span className="kb-ex-row__dot" aria-label={state === 'new' ? 'New' : undefined} />
        <span className="kb-ex-row__title">{f.work.title}</span>
        <span className="kb-ex-row__meta">{meta}
          {f.access === 'paid' && <>{' · '}<span className="kb-ex-tag is-paid">Paid</span></>}
          {f.access === 'open' && <>{' · '}<span className="kb-ex-tag is-free">Free</span></>}
        </span>
        {f.has_abstract === false || !f.work.abstract
          ? <span className="kb-ex-row__abstract is-none">No abstract from the source — open it to read.</span>
          : <span className="kb-ex-row__abstract">{f.work.abstract}</span>}
      </button>
      {state === 'dismissed' && <Button size="sm" className="kb-ex-row__restore" onClick={onRestore}>Restore</Button>}
    </div>
  );
}

function ReaderHead({ f, busy, onClose, onAdd, onDiscuss, onBrowser, onDismiss, onRestore, onOpenDocument }: {
  f: KbFinding; busy: boolean; onClose: () => void; onAdd: () => void; onDiscuss: () => void; onBrowser: () => void;
  onDismiss: () => void; onRestore: () => void; onOpenDocument: (target: DocTarget) => void;
}) {
  const state = f.state ?? 'new';
  const why = f.new_line ?? f.reason;
  return (
    <header className="kb-ex-reader__head">
      <div className="kb-ex-reader__top">
        <h3>{f.work.title}</h3>
        <button type="button" className="kb-ex-icon" aria-label="Close paper" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      <p className="kb-ex-muted">{authorsLine(f)}</p>
      {f.new_line
        ? <p className="kb-ex-reader__new" title={f.new_line}><b>New for you:</b> {f.new_line}</p>
        : <p className="kb-ex-reader__new kb-ex-muted">Mostly repeats what your wiki has.</p>}
      {f.wiki_refs.length > 0 && <div className="kb-ex-chips">
        <span className="kb-ex-muted">In your wiki:</span>
        {f.wiki_refs.slice(0, 3).map((ref) => (
          <button key={ref.page_id} type="button" className="kb-ex-chip" onClick={() => onOpenDocument({ type: 'page', id: ref.page_id })}>{ref.title}</button>
        ))}
      </div>}
      {f.access === 'paid' && state !== 'materials' && <p className="kb-ex-paid">
        This article is paid. I think it&apos;s useful because {lowerFirst(why || 'it continues your topic')}. You can check it yourself; if you get it, add it to your materials.
      </p>}
      {state === 'materials' ? (
        <div className="kb-ex-instate">
          <Icon name="check" size={14} />
          <span>In Materials › From Explore · not in the wiki</span>
          {f.material_id && <Button size="sm" onClick={() => onOpenDocument({ type: 'material', id: f.material_id! })}>Open</Button>}
          <Button size="sm" disabled={busy} onClick={onDiscuss}>Discuss</Button>
        </div>
      ) : (
        <div className="kb-ex-acts">
          <Button size="sm" variant="fill" icon="plus" disabled={busy} onClick={onAdd}>Add to materials</Button>
          <Button size="sm" icon="chats" disabled={busy} onClick={onDiscuss}>Discuss</Button>
          <Button size="sm" icon="external" onClick={onBrowser}>Open in browser</Button>
          {state === 'dismissed'
            ? <Button size="sm" variant="quiet" disabled={busy} onClick={onRestore}>Restore</Button>
            : <Button size="sm" variant="quiet" disabled={busy} onClick={onDismiss}>Not for me</Button>}
        </div>
      )}
    </header>
  );
}

type FilterKey = 'year' | 'type' | 'show' | 'sort';

function Filters({ filters, onChange, onCovered }: { filters: FindingFilters; onChange: (f: FindingFilters) => void; onCovered: (c: boolean) => void }) {
  const year = useRef<HTMLButtonElement | null>(null);
  const type = useRef<HTMLButtonElement | null>(null);
  const show = useRef<HTMLButtonElement | null>(null);
  const sort = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<FilterKey | null>(null);
  // A menu is drawn in the page, so the paper's native view must not sit over it.
  useEffect(() => { onCovered(menu !== null); }, [menu, onCovered]);
  const pick = (patch: Partial<FindingFilters>) => { onChange({ ...filters, ...patch }); setMenu(null); };
  const year0 = new Date().getFullYear();
  const items = useMemo<Record<FilterKey, MenuItem[]>>(() => ({
    year: [
      { id: 'any', label: 'Any year', onSelect: () => pick({ year: 'any' }) },
      { id: '1y', label: 'Last 12 months', onSelect: () => pick({ year: '1y' }) },
      { id: '3y', label: 'Last 3 years', onSelect: () => pick({ year: '3y' }) },
      { id: 'this', label: `${year0} only`, onSelect: () => pick({ year: { from: year0, to: year0 } }) },
    ],
    type: (['any', 'preprint', 'peer_reviewed', 'review', 'other'] as const).map((t) => ({
      id: t, label: t === 'any' ? 'Any type' : t === 'peer_reviewed' ? 'Peer-reviewed (journal, conference)' : TYPE_LABEL[t], onSelect: () => pick({ type: t }),
    })),
    show: (['active', 'new', 'seen', 'dismissed'] as const).map((s) => ({
      id: s, label: s === 'active' ? 'New & seen' : s === 'dismissed' ? 'Not for me' : `Only ${s}`, onSelect: () => pick({ show: s }),
    })),
    sort: (['for_you', 'newest', 'cited'] as const).map((s) => ({ id: s, label: SORT_LABEL[s], onSelect: () => pick({ sort: s }) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filters]);
  const btn = (key: FilterKey, ref: typeof year, label: string, on: boolean) => (
    <button ref={ref} type="button" className={`kb-ex-filter${on ? ' is-on' : ''}`} aria-haspopup="menu" aria-expanded={menu === key}
      onClick={() => setMenu(menu === key ? null : key)}>{label}<Icon name="chevronDown" size={12} /></button>
  );
  return (
    <div className="kb-ex-filters" role="toolbar" aria-label="Filters">
      <button type="button" className={`kb-ex-filter${filters.free ? ' is-on' : ''}`} aria-pressed={filters.free}
        onClick={() => onChange({ ...filters, free: !filters.free })}>{filters.free && <Icon name="check" size={12} />}Free only</button>
      {btn('year', year, YEAR_LABEL(filters.year), filters.year !== 'any')}
      {btn('type', type, TYPE_LABEL[filters.type], filters.type !== 'any')}
      {btn('show', show, SHOW_LABEL[filters.show], filters.show !== 'active')}
      {btn('sort', sort, SORT_LABEL[filters.sort], false)}
      {menu && <Menu open onClose={() => setMenu(null)} placement="bottom-start"
        anchorRef={{ year, type, show, sort }[menu]} label={{ year: 'Year', type: 'Type', show: 'Show', sort: 'Sort' }[menu]} items={items[menu]} />}
    </div>
  );
}
