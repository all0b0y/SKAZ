import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { KbFinding, KbFolder, KbSearch } from '../../api/kb/types.gen';
import type { ExploreClient } from '../api/explore';
import type { DocTarget } from '../state/document';
import { EXPLORE_LIST_MAX, EXPLORE_LIST_MIN } from '../state/prefs';
import type { SettingsSection } from '../state/ui';
import type { ToastData } from '../ui/Toast';
import { Button, Icon, Menu, TextField, type MenuItem } from '../ui';
import { Resizer } from '../shell/Resizer';
import { exploreIssue } from './errors';
import {
  DEFAULT_FILTERS, SHOW_LABEL, SORT_LABEL, TYPE_LABEL, YEAR_LABEL, filtersActive, filtersQuery, readFilters, writeFilters,
  type FindingFilters,
} from './filters';
import { PaperReader } from './PaperReader';

type Toast = (toast: Omit<ToastData, 'id'>) => void;

const TYPE_TEXT: Record<string, string> = {
  preprint: 'Preprint', 'posted-content': 'Preprint', article: 'Journal article', 'journal-article': 'Journal article',
  'conference-paper': 'Conference paper', 'proceedings-article': 'Conference paper', review: 'Review',
  dissertation: 'Dissertation', 'book-chapter': 'Book chapter',
};

/** What a paused or failed search says, and what can be done about it. `settings` says which part of
 * Settings its button opens: `true` = the search settings (FX: `agent_required` needs the chat agent). */
export const STOP_TEXT: Record<string, { text: string; settings?: SettingsSection | true; resume?: string }> = {
  decision_model_required: { text: 'Set up a decision model to check which papers fit the topic.', settings: true },
  science_consent_required: { text: 'SKAZ needs your OK to send the topic words to OpenAlex. Turn it on in Settings, then continue.', settings: true, resume: 'Continue' },
  openalex_daily_limit: { text: "OpenAlex's free daily limit is reached. Continue tomorrow, or add a free key in Settings.", settings: true, resume: 'Continue' },
  agent_required: { text: 'Set up a chat agent in Settings to turn your request into English search terms.', settings: 'models', resume: 'Continue' },
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

/** FX-2: how much of the paper actually went to Materials — said in the toast and the reader's note. */
export function importNote(content: KbFinding['imported_content']): string {
  if (content === 'abstract_only') return ' (abstract only)';
  if (content === 'link_only') return ' (link only)';
  return '';
}

/** FX-5: the words field of «Edit words and search again» — commas separate the terms that go out. */
export function splitTerms(text: string): string[] {
  return text.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
}

/** FX-5: the live line of steps while a search runs — the active one bold, the finished ones checked. */
export function liveSteps(search: KbSearch): Array<{ title: string; note: string | null; on: boolean; done: boolean }> {
  const stepOf: Record<string, number> = { plan: 1, collect: 2, rules: 2, links: 2, decision: 3, repeats: 3, novelty: 4, ready: 4 };
  const now = stepOf[search.stage] ?? 1;
  const terms = search.terms && search.terms.length > 0 ? `(${search.terms.join(' · ')})` : null;
  const checking = (search.after_rules ?? 0) > 0 || (search.decided ?? 0) > 0
    ? `${search.decided ?? 0}/${search.after_rules || search.found}` : null;
  const comparing = search.novelty_checked ? `${search.novelty_checked}/${search.fit}` : null;
  return [
    { title: 'Understanding your request', note: null, on: now === 1, done: now > 1 },
    { title: 'Searching OpenAlex', note: terms, on: now === 2, done: now > 2 },
    { title: 'Checking fit', note: checking, on: now === 3, done: now > 3 },
    { title: 'Comparing with your wiki', note: comparing, on: now === 4, done: now > 4 },
  ];
}

const pageUrl = (f: KbFinding): string | null => f.read_url ?? (f.work.doi ? `https://doi.org/${f.work.doi}` : null);

export interface SearchPageProps {
  search: KbSearch;
  scopeName: string;
  explore: ExploreClient;
  parallelLimit: number;
  /** FX-4: the papers list's width while a paper is open; the divider between them keeps it in prefs. */
  listWidth: number;
  onListWidth: (px: number) => void;
  /** FX-5: a search started from this page («Edit words and search again») opens as this page's search. */
  onStarted: (id: string) => void | Promise<void>;
  /** Something sits over the page (a menu, a dialog, the toast): the reader's native view steps aside. */
  covered: boolean;
  /** A menu of this page is open (true) or closed (false); it switches itself off when the page goes away. */
  onCovered: (covered: boolean) => void;
  onChanged: () => void;
  onDiscuss: (chatId: string, material?: { id: string; title: string } | null) => void;
  onOpenDocument: (target: DocTarget) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  toast: Toast;
  /** F6: the library's folders — Add to materials can land the paper in one of them. */
  folders?: ReadonlyArray<KbFolder>;
  /** Current locations from the library, including papers imported before this page mounted. */
  materialFolderNames?: Readonly<Record<string, string>>;
  /** F6: moves the material the paper became into a folder (PATCH /kb/materials/{id}). */
  onMoveMaterial?: (materialId: string, folderId: string) => Promise<void>;
  /** F6: makes a folder right from the add menu; null when the backend refused the name. */
  onCreateFolder?: (name: string) => Promise<{ id: string; name: string } | null>;
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
  /** FX-2: the paper whose Add to materials request is on its way (its button says Importing…). */
  const [adding, setAdding] = useState<string | null>(null);
  /** F6: the folder the papers of this page land in — From Explore until the user picks another. */
  const [targetFolder, setTargetFolder] = useState<{ id: string; name: string }>({ id: 'fld-explore', name: 'From Explore' });
  /** F6: where each added paper actually landed (finding id → folder name). */
  const [materialFolders, setMaterialFolders] = useState<Record<string, string>>({});
  // A library refresh (including a move/rename elsewhere) supersedes this page's optimistic names.
  useEffect(() => { setMaterialFolders({}); }, [props.materialFolderNames]);
  const generation = useRef(0);

  useEffect(() => () => onCovered(false), [onCovered]);

  const setFilters = (next: FindingFilters) => { setFiltersState(next); writeFilters(next); };

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const res = await explore.search_findings(filtersQuery(search.id, filters));
      if (mine !== generation.current) return;
      const list = res.groups.flatMap((g) => g.findings);
      setRows(list);
      // A paper the user is reading takes each fresh state the list reads (an import that landed, FX-2).
      setOpen((now) => (now ? list.find((f) => f.id === now.id) ?? now : now));
      setFailed(null);
    } catch (error) {
      if (mine === generation.current) setFailed(exploreIssue(error).message);
    }
  }, [explore, search.id, filters]);

  // New findings arrive while the search runs; a finished search is read once per change. Every count a
  // running search moves rereads the papers (FX-5), so they appear as soon as novelty has checked them.
  useEffect(() => { void load(); }, [load, search.state, search.stage, search.found, search.decided, search.fit, search.novelty_checked, search.new, search.unseen]);

  // While the search runs — or a paper still imports in the background (FX-2) — the page keeps a steady
  // beat of its own, so new papers and finished imports show up without anything else changing. The
  // paper being read is also asked on its own: once it lands it leaves the filtered list.
  const openId = open?.id ?? null;
  const openImporting = open !== null && (open.state === 'importing' || open.importing === true);
  const anyImporting = openImporting || (rows ?? []).some((f) => f.state === 'importing' || f.importing === true);
  useEffect(() => {
    if (search.state !== 'running' && !anyImporting) return undefined;
    const timer = window.setInterval(() => {
      void load();
      if (openImporting && openId !== null) {
        void explore.finding(openId).then((next) => {
          setRows((old) => old?.map((f) => (f.id === next.id ? next : f)) ?? old);
          setOpen((now) => (now && now.id === next.id ? next : now));
        }).catch(() => undefined);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [search.state, anyImporting, openImporting, openId, load, explore]);

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

  /** FX-2: the paper goes to Materials — its PDF or open text when there is one, else the real abstract,
   * else just the link. A big import continues in the background; the button says Importing… until then.
   * F6: it can land in a folder the user picked; From Explore is where it goes by default. */
  const addToMaterials = (f: KbFinding, targetFolderId?: string, targetFolderName?: string) => {
    if (busy || adding !== null) return;
    setAdding(f.id);
    void act(async () => {
      try {
        const added = await explore.add_to_materials(f.id);
        // Import and move are two writes. Preserve the first success even if the second fails.
        replace({ ...f, state: added.importing ? 'importing' : 'materials', material_id: added.material_id ?? null,
          importing: added.importing ?? false, imported_content: added.content ?? null });
        onChanged();
        // A folder the user picked takes the material there; From Explore is where the backend puts it.
        if (targetFolderId && targetFolderId !== 'fld-explore' && added.material_id && props.onMoveMaterial) {
          try {
            await props.onMoveMaterial(added.material_id, targetFolderId);
          } catch {
            toast({ text: `Added to Materials › From Explore, but couldn’t move it to ${targetFolderName ?? 'the chosen folder'}. Use Folder to try again.`, tone: 'problem' });
            return;
          }
        }
        const moved = targetFolderId && targetFolderId !== 'fld-explore' && added.material_id && props.onMoveMaterial;
        const folderName = moved ? targetFolderName ?? 'From Explore'
          : (added.material_id ? props.materialFolderNames?.[added.material_id] : undefined) ?? 'From Explore';
        setMaterialFolders((prev) => ({ ...prev, [f.id]: folderName }));
        toast({ text: `Added to Materials › ${folderName}${importNote(added.content)} · not in the wiki yet`, tone: 'done' });
      } finally {
        setAdding(null);
      }
    });
  };

  /** F6: a paper already in Materials moves to another folder; the plaque and the toast name it. */
  const moveMaterial = (f: KbFinding, folderId: string, folderName: string) => {
    const move = props.onMoveMaterial;
    const materialId = f.material_id;
    if (!move || !materialId) return;
    void act(async () => {
      await move(materialId, folderId);
      setMaterialFolders((prev) => ({ ...prev, [f.id]: folderName }));
      toast({ text: `Moved to Materials › ${folderName}`, tone: 'done' });
    });
  };

  /** FX-5: an empty answer is a words problem — the edited words start a new run and open it here. */
  const searchAgain = (text: string) => {
    const words = text.trim();
    if (!words) return;
    void act(async () => {
      const started = await explore.start({
        area_id: search.area_id, query: words,
        plan: [{ area_id: search.area_id, label: words, terms: splitTerms(words) }],
      });
      await props.onStarted(started.id);
    });
  };

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
    const matId = talk.material_id ?? f.material_id ?? null;
    replace({ ...f, discuss_chat_id: talk.chat_id, ...(matId ? { material_id: matId } : {}) });
    if (matId) props.onDiscuss(talk.chat_id, { id: matId, title: f.work.title });
    else props.onDiscuss(talk.chat_id);
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
    <div className={`kb-ex-search${open ? '' : ' is-wide'}`}>
      <section id="kb-ex-list" className="kb-ex-list" aria-label="Papers found"
        style={{ '--kb-ex-list-w': `${props.listWidth}px` } as CSSProperties}>
        <header className="kb-ex-list__head">
          <div className="kb-ex-list__title">
            <h2 title={search.name}>{search.name}</h2>
            {search.query && <span className="kb-ex-muted">in {props.scopeName}</span>}
          </div>
          {search.state !== 'running' && search.state !== 'queued' && search.terms && search.terms.length > 0 && (
            <p className="kb-ex-terms" title={search.terms.join(' · ')}>Searched for: {search.terms.join(' · ')}</p>
          )}
          <Progress search={search} limit={props.parallelLimit} steps={steps} onSteps={() => setSteps((s) => !s)}
            busy={busy} onResume={() => void resume()} onPause={() => void pause()} onOpenSettings={props.onOpenSettings} />
        </header>
        <Filters filters={filters} onChange={setFilters} onCovered={onCovered} />
        <div className="kb-ex-rows" role="list">
          {failed && <div className="kb-ex-empty" role="alert"><p>{failed}</p><Button size="sm" onClick={() => void load()}>Try again</Button></div>}
          {!failed && rows === null && <p className="kb-ex-muted kb-ex-pad" role="status">Loading…</p>}
          {!failed && rows !== null && rows.length === 0 && (
            <Empty search={search} filters={filters} onClear={() => setFilters({ ...DEFAULT_FILTERS, sort: filters.sort })}
              onShowPaid={() => setFilters({ ...filters, free: false })} onAgain={searchAgain} />
          )}
          {rows?.map((f) => <Row key={f.id} f={f} open={f.id === open?.id}
            importing={adding === f.id || f.state === 'importing' || f.importing === true}
            onOpen={() => openRow(f)} onRestore={() => void restore(f)} />)}
        </div>
      </section>
      {open && <>
        <Resizer label="Resize papers list" controls="kb-ex-list" value={props.listWidth}
          min={EXPLORE_LIST_MIN} max={EXPLORE_LIST_MAX} direction={1} onChange={props.onListWidth} />
        <section className="kb-ex-reader" aria-label="Paper">
          <ReaderHead f={open} busy={busy} importing={adding === open.id || open.state === 'importing' || open.importing === true}
            folders={props.folders ?? []} targetFolder={targetFolder}
            folderName={materialFolders[open.id] ?? (open.material_id ? props.materialFolderNames?.[open.material_id] : undefined) ?? 'From Explore'}
            onCreateFolder={props.onCreateFolder}
            onPickFolder={(id, name) => setTargetFolder({ id, name })}
            onAdd={(folderId, folderName) => addToMaterials(open, folderId, folderName)}
            onMove={props.onMoveMaterial && open.material_id
              ? (folderId, folderName) => moveMaterial(open, folderId, folderName)
              : undefined}
            onClose={() => setOpen(null)}
            onDiscuss={() => void discuss(open)} onBrowser={() => openInBrowser(open)} onDismiss={() => void dismiss(open)}
            onRestore={() => void restore(open)} onOpenDocument={props.onOpenDocument} onCovered={onCovered} />
          <PaperReader url={pageUrl(open)} covered={props.covered} />
        </section>
      </>}
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
    const list = liveSteps(search);
    const activeIndex = list.findIndex((s) => s.on);
    const active = list[activeIndex] ?? list[0]!;
    return <div className="kb-ex-progress" role="status">
      <div className="kb-ex-progress__top">
        <span className="kb-ex-progress__summary">
          <b>Step {activeIndex + 1} of {list.length} · {active.title}</b>
        </span>
        <Button size="sm" variant="quiet" disabled={busy} onClick={onPause}>Stop</Button>
      </div>
      <div className="kb-ex-bars" aria-hidden="true">
        {list.map((s) => (
          <div key={s.title} className={`kb-ex-bar-seg${s.done ? ' is-done' : ''}${s.on ? ' is-on' : ''}`}>
            {s.on && <span />}
          </div>
        ))}
      </div>
      <ol className="kb-ex-live" aria-label="Search steps">
        {list.map((s) => (
          <li key={s.title} className={`kb-ex-live__step${s.done ? ' is-done' : ''}${s.on ? ' is-on' : ''}`}
            aria-current={s.on ? 'step' : undefined}>
            {s.done && <Icon name="check" size={12} />}
            <span>{s.title}</span>
            {s.note && <span className="kb-ex-live__note">{s.note}</span>}
          </li>
        ))}
      </ol>
    </div>;
  }
  if (search.state === 'paused' || search.state === 'error') {
    const stop = STOP_TEXT[search.stop_reason ?? (search.state === 'error' ? 'failed' : 'user_pause')] ?? STOP_TEXT.user_pause!;
    const isBudgetBatch = search.state === 'paused' && search.stop_reason === 'budget' && search.new > 0;
    const remaining = Math.max((search.fit ?? 0) - (search.novelty_checked ?? 0), 0);
    return <div className={`kb-ex-stop${isBudgetBatch ? ' is-batch' : ''}`} role="alert">
      <span>
        {isBudgetBatch && <><b>{search.new} new papers ready</b> · {search.found} found → {search.fit} fit{remaining > 0 ? ` (${remaining} more fit)` : ''} · </>}
        {stop.text}
      </span>
      {stop.settings && <Button size="sm" onClick={() => onOpenSettings(stop.settings === true ? 'search' : stop.settings)}>Open Settings</Button>}
      {stop.resume && search.checkpoint_id && (
        <Button size="sm" disabled={busy} onClick={onResume}>{stop.resume}</Button>
      )}
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

function Empty({ search, filters, onClear, onShowPaid, onAgain }: {
  search: KbSearch; filters: FindingFilters; onClear: () => void; onShowPaid: () => void; onAgain: (words: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState(() => search.terms?.join(', ') || search.query);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (words.trim()) onAgain(words);
  };
  if (search.state === 'running' || search.state === 'queued') return <p className="kb-ex-muted kb-ex-pad">Papers appear here as they are checked.</p>;
  if (search.state === 'paused' || search.state === 'error') return <p className="kb-ex-muted kb-ex-pad">Nothing to show yet.</p>;
  /** FX-5: the words this search went out with — its English terms, or the request as typed. */
  const searched = search.terms?.length ? search.terms.join(' · ') : search.query;
  /** An empty answer is a words problem (FX-5): say the words, offer to edit them and search again. */
  const again = <div className="kb-ex-again">
    {searched && <span className="kb-ex-muted">Searched for: {searched}</span>}
    {editing ? (
      <form className="kb-ex-again__edit" onSubmit={submit}>
        <TextField label="Search words" value={words} maxLength={200} autoFocus
          onChange={(e) => setWords(e.target.value)} />
        <Button size="sm" variant="fill" type="submit" disabled={!words.trim()}>Search again</Button>
      </form>
    ) : (
      <Button size="sm" onClick={() => setEditing(true)}>Edit words and search again</Button>
    )}
  </div>;
  if (search.found === 0) {
    return <div className="kb-ex-empty"><strong>Nothing found</strong><span className="kb-ex-muted">No papers came back for these words.</span>{again}</div>;
  }
  if (search.new === 0) {
    return <div className="kb-ex-empty"><strong>Nothing new for you</strong><span className="kb-ex-muted">
      {search.no_text > 0
        ? `Every paper that fit is already in your wiki, or had no text to read (${search.no_text}).`
        : 'Every paper that fit is already covered by your wiki.'}
    </span>{again}</div>;
  }
  return <div className="kb-ex-empty">
    <strong>Nothing matches the filters</strong>
    {filtersActive(filters) || !filters.free
      ? <Button size="sm" onClick={onClear}>Clear filters</Button>
      : <Button size="sm" onClick={onShowPaid}>Show paid papers too</Button>}
  </div>;
}

function Row({ f, open, importing, onOpen, onRestore }: {
  f: KbFinding; open: boolean; importing: boolean; onOpen: () => void; onRestore: () => void;
}) {
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
        {importing && <span className="kb-ex-row__import"><Icon name="retry" size={12} className="kb-explore-spin" />Importing…</span>}
        {f.has_abstract === false || !f.work.abstract
          ? <span className="kb-ex-row__abstract is-none">No abstract from the source — open it to read.</span>
          : <span className="kb-ex-row__abstract">{f.work.abstract}</span>}
      </button>
      {state === 'dismissed' && <Button size="sm" className="kb-ex-row__restore" onClick={onRestore}>Restore</Button>}
    </div>
  );
}

function ReaderHead({ f, busy, importing, folders, targetFolder, folderName, onCreateFolder, onPickFolder, onAdd, onMove,
  onClose, onDiscuss, onBrowser, onDismiss, onRestore, onOpenDocument, onCovered }: {
  f: KbFinding; busy: boolean; importing: boolean;
  /** F6: the library's folders — the caret's menu picks one to add the paper into (or makes a new one). */
  folders: ReadonlyArray<KbFolder>;
  /** F6: the folder the next add goes to — From Explore until the user picks another. */
  targetFolder: { id: string; name: string };
  /** F6: the folder this paper landed in; From Explore when nothing else is known. */
  folderName: string;
  /** F6: given when the section can create folders — the menu shows «New folder…». */
  onCreateFolder?: (name: string) => Promise<{ id: string; name: string } | null>;
  onPickFolder: (id: string, name: string) => void;
  onAdd: (folderId?: string, folderName?: string) => void;
  onMove: ((folderId: string, folderName: string) => void) | undefined;
  onClose: () => void; onDiscuss: () => void; onBrowser: () => void; onDismiss: () => void; onRestore: () => void;
  onOpenDocument: (target: DocTarget) => void; onCovered: (covered: boolean) => void;
}) {
  const state = f.state ?? 'new';
  const why = f.new_line ?? f.reason;
  // F6: the split button's folder menu, and the menu that moves an added paper elsewhere.
  const folderBtnRef = useRef<HTMLButtonElement | null>(null);
  const moveBtnRef = useRef<HTMLButtonElement | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const createGeneration = useRef(0);
  // Another paper takes the menus with it: nothing stays open across the switch.
  useEffect(() => {
    setFolderMenuOpen(false);
    setMoveMenuOpen(false);
    setCreatingFolder(false);
    setCreating(false);
    setNewFolderName('');
    setCreateError(null);
    return () => { createGeneration.current += 1; };
  }, [f.id]);
  // A menu is drawn in the page, so the paper's native view must not sit over it (as in Filters).
  useEffect(() => {
    onCovered(folderMenuOpen || moveMenuOpen);
    return () => onCovered(false);
  }, [folderMenuOpen, moveMenuOpen, onCovered]);

  const otherFolders = folders.filter((x) => x.id !== 'fld-explore');
  const addItems = useMemo<MenuItem[]>(() => [
    {
      id: 'fld-explore', label: 'From Explore', icon: 'inbox',
      note: targetFolder.id === 'fld-explore' ? 'Current' : undefined,
      onSelect: () => { onPickFolder('fld-explore', 'From Explore'); onAdd('fld-explore', 'From Explore'); },
    },
    ...otherFolders.map((folder) => ({
      id: folder.id, label: folder.name, icon: 'folder' as const,
      onSelect: () => { onPickFolder(folder.id, folder.name); onAdd(folder.id, folder.name); },
    })),
    ...(onCreateFolder ? [{
      id: '__new', label: 'New folder…', icon: 'folderPlus' as const,
      onSelect: () => { setNewFolderName(''); setCreateError(null); setCreatingFolder(true); },
    }] : []),
  ], [otherFolders, targetFolder.id, onPickFolder, onAdd, onCreateFolder]);
  const moveItems = useMemo<MenuItem[]>(() => [
    {
      id: 'fld-explore', label: 'From Explore', icon: 'inbox',
      note: folderName === 'From Explore' ? 'Current' : undefined,
      onSelect: () => onMove?.('fld-explore', 'From Explore'),
    },
    ...otherFolders.map((folder) => ({
      id: folder.id, label: folder.name, icon: 'folder' as const,
      note: folderName === folder.name ? 'Current' : undefined,
      onSelect: () => onMove?.(folder.id, folder.name),
    })),
  ], [otherFolders, folderName, onMove]);

  /** «New folder…»: make the folder, then the paper goes straight into it. */
  const submitNewFolder = (event: FormEvent) => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name || busy || importing || creating || !onCreateFolder) return;
    const mine = ++createGeneration.current;
    setCreating(true);
    onCreateFolder(name).then((created) => {
      if (mine !== createGeneration.current) return;
      setCreating(false);
      if (!created) { setCreateError('Couldn’t create the folder. Try another name.'); return; }
      setCreatingFolder(false);
      setNewFolderName('');
      setCreateError(null);
      onPickFolder(created.id, created.name);
      onAdd(created.id, created.name);
    }).catch(() => {
      if (mine !== createGeneration.current) return;
      setCreating(false); setCreateError('Couldn’t create the folder. Try another name.');
    });
  };
  const cancelNewFolder = () => { setCreatingFolder(false); setNewFolderName(''); setCreateError(null); };

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
          <span>In Materials › {folderName}{importNote(f.imported_content)} · not in the wiki</span>
          {onMove && f.material_id && folders.length > 0 && <>
            <button ref={moveBtnRef} type="button" className="kb-ex-move" aria-label="Move to folder" aria-haspopup="menu"
              aria-expanded={moveMenuOpen} disabled={busy} onClick={() => setMoveMenuOpen((v) => !v)}>
              Folder: {folderName}<Icon name="chevronDown" size={12} />
            </button>
            <Menu open={moveMenuOpen} onClose={() => setMoveMenuOpen(false)} anchorRef={moveBtnRef}
              placement="bottom-start" label="Move to folder" items={moveItems} />
          </>}
          {f.material_id && <Button size="sm" onClick={() => onOpenDocument({ type: 'material', id: f.material_id! })}>Open</Button>}
          <Button size="sm" disabled={busy} onClick={onDiscuss}>Discuss</Button>
        </div>
      ) : (
        <div className="kb-ex-acts">
          <span className="kb-ex-split">
            <Button size="sm" variant="fill" icon="plus" disabled={busy || importing} busy={importing}
              onClick={() => onAdd(targetFolder.id, targetFolder.name)}>
              {importing ? 'Importing…' : targetFolder.id === 'fld-explore' ? 'Add to materials' : `Add to «${targetFolder.name}»`}
            </Button>
            <button ref={folderBtnRef} type="button" className="kb-ex-split__caret" aria-label="Choose folder for material"
              aria-haspopup="menu" aria-expanded={folderMenuOpen} disabled={busy || importing}
              onClick={() => setFolderMenuOpen((v) => !v)}>
              <Icon name="chevronDown" size={12} />
            </button>
          </span>
          <Menu open={folderMenuOpen} onClose={() => setFolderMenuOpen(false)} anchorRef={folderBtnRef}
            placement="bottom-start" label="Add to folder" items={addItems} />
          {creatingFolder && (
            <form className="kb-ex-newfolder" onSubmit={submitNewFolder}>
              <TextField label="New folder name" value={newFolderName} maxLength={200} autoFocus error={createError}
                onChange={(e) => setNewFolderName(e.target.value)} />
              <Button size="sm" variant="fill" type="submit" disabled={!newFolderName.trim() || busy || importing || creating}>
                Create &amp; add
              </Button>
              <Button size="sm" type="button" disabled={creating} onClick={cancelNewFolder}>Cancel</Button>
            </form>
          )}
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
