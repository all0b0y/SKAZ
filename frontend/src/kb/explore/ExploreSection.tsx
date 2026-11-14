import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import type { KbArea, KbAreaMap } from '../../api/kb/types.gen';
import { useOptionalServices } from '../state/context';
import type { DocTarget } from '../state/document';
import { createPrefsStore } from '../state/prefs';
import { createUiStore, type SettingsSection, type UiState } from '../state/ui';
import type { ToastData } from '../ui/Toast';
import { Icon } from '../ui';
import { exploreIssue } from './errors';
import { exploreState, watchSearches } from './exploreState';
import { MapPage } from './MapPage';
import { SearchPage } from './SearchPage';
import { TopicDialog, type TopicEdit } from './TopicDialog';
import { TOPICS_CHANGED } from './topicEvents';
import { createExploreClients, weekdayShort, type ExploreClients, type ExploreSectionProps } from './types';
import { useCover } from './useCover';
import './explore.css';
import './explore-v2.css';

/** Stands in for the window's UI state when the section is shown without the app's services (tests, previews). */
const NO_UI = createUiStore();

/** Same for the preferences: their defaults, never stored (FX-4 list width falls back to 380). */
const NO_PREFS = createPrefsStore(null);

/**
 * Something of the window sits over the page: a dialog, the ⌘K palette, or the toast. The paper's native view
 * is drawn above all of them, so it steps aside until they are gone.
 */
const overlayUp = (s: UiState): boolean =>
  s.settingsOpen || s.librarySetupOpen || s.addMaterialOpen || s.searchOpen || s.decisionId !== null
  || s.editModels !== null || s.toast !== null;

/**
 * EX3 (Explore v2, UX-1…UX-16). Explore finds papers to read and add. The page is either the map of the
 * wiki (tiles sized by its concepts, a topic panel beside it) or one search full page: its funnel line,
 * filters, the papers, and the paper itself in the reader slot. The searches list lives in the side panel
 * (ExploreSide). One Find button, at the top; nothing slides in or shifts the layout (UX-14).
 */
export function ExploreSection({
  hidden = false,
  clients: clientsProp,
  onOpenDocument: onOpenDocumentProp,
  onOpenSettings: onOpenSettingsProp,
}: ExploreSectionProps) {
  const services = useOptionalServices();
  const clients = useMemo<ExploreClients>(() => {
    if (clientsProp) return clientsProp;
    if (!services) throw new Error('ExploreSection needs KbServicesProvider or a clients prop');
    return createExploreClients(services.client);
  }, [clientsProp, services]);
  const store = useMemo(() => exploreState(services?.client ?? clients, clients.explore.searches), [services, clients]);
  const nav = useStore(store);
  useEffect(() => (hidden ? undefined : watchSearches(store)), [store, hidden]);

  const pageCover = useCover(store);
  const overlay = useStore(services?.ui ?? NO_UI, overlayUp);
  const covered = hidden || overlay || nav.covers > 0;

  // FX-4: the papers list's width while a paper is open, kept in the stored preferences.
  const prefs = services?.prefs ?? NO_PREFS;
  const listWidth = useStore(prefs, (s) => s.exploreListWidth);

  // FX-5: a search that finishes while you are looking at it does not also ring the bell — its
  // «Search finished» note is dismissed as soon as it arrives (or as soon as you open that search).
  const notes = services?.notifications ?? null;
  useEffect(() => {
    if (!notes || hidden) return undefined;
    const dropSeen = (): void => {
      const page = store.getState().page;
      if (page.kind !== 'search') return;
      for (const n of notes.getState().items) {
        const jobId = n.payload?.job_id;
        if (n.kind !== 'explore_finished' || typeof jobId !== 'string' || jobId !== page.id) continue;
        void notes.getState().dismiss(n.id);
      }
    };
    dropSeen();
    const stopNotes = notes.subscribe(dropSeen);
    const stopPage = store.subscribe(dropSeen);
    return () => { stopNotes(); stopPage(); };
  }, [notes, store, hidden]);

  const openDocument = useCallback((target: DocTarget) => {
    if (onOpenDocumentProp) onOpenDocumentProp(target);
    else services?.ui.getState().openDocument(target);
  }, [onOpenDocumentProp, services]);
  const openSettings = useCallback((section?: SettingsSection) => {
    if (onOpenSettingsProp) onOpenSettingsProp(section);
    else services?.ui.getState().openSettings(section);
  }, [onOpenSettingsProp, services]);
  const toast = useCallback((t: Omit<ToastData, 'id'>) => services?.ui.getState().showToast(t), [services]);

  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [edit, setEdit] = useState<TopicEdit | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const names = useRef(new Map<string, string>());
  const [, setNamesVersion] = useState(0);
  const [weekly, setWeekly] = useState<{ day: string | null; waiting: { checkId: string; count: number } | null }>({ day: null, waiting: null });

  const onMap = useCallback((map: KbAreaMap) => {
    let changed = false;
    for (const a of [...map.breadcrumbs, ...map.areas]) {
      if (names.current.get(a.id) !== a.name) { names.current.set(a.id, a.name); changed = true; }
    }
    if (changed) setNamesVersion((n) => n + 1);
  }, []);

  useEffect(() => {
    const changed = () => setReloadKey((k) => k + 1);
    window.addEventListener(TOPICS_CHANGED, changed);
    return () => window.removeEventListener(TOPICS_CHANGED, changed);
  }, []);

  useEffect(() => {
    if (hidden) return undefined;
    let live = true;
    void clients.maintenance.settings().then((s) => {
      if (!live) return;
      setWeekly({
        day: s.enabled ? weekdayShort(s.next_due_at) : null,
        waiting: s.latest_check_id && s.candidates_waiting > 0 ? { checkId: s.latest_check_id, count: s.candidates_waiting } : null,
      });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [clients, hidden]);

  const page = nav.page;
  const search = page.kind === 'search' ? nav.searches.find((s) => s.id === page.id) ?? null : null;
  const nameOf = (id: string | null) => (id ? names.current.get(id) ?? 'this topic' : 'All your topics');

  // A search opened from the side list names a topic this session has not met on the map yet: read its level,
  // whose path carries the name.
  const searchArea = search?.area_id ?? null;
  useEffect(() => {
    if (hidden || !searchArea || names.current.has(searchArea)) return undefined;
    let live = true;
    void clients.areas.map({ parent_id: searchArea }).then((map) => { if (live) onMap(map); }).catch(() => undefined);
    return () => { live = false; };
  }, [clients, hidden, onMap, searchArea]);
  const scopeIds: Array<string | null> = search ? [search.area_id] : nav.multi.length > 1 ? nav.multi : [nav.selected];
  const scopeLabel = nav.multi.length > 1 && !search ? `${nav.multi.length} topics` : nameOf(scopeIds[0] ?? null);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setIssue(null);
    try { await action(); } catch (error) { setIssue(exploreIssue(error).message); } finally { setBusy(false); }
  };

  const find = (event?: FormEvent) => {
    event?.preventDefault();
    const q = query.trim();
    void run(async () => {
      const started = [];
      for (const area of scopeIds) {
        started.push(await clients.explore.start({ area_id: area ?? null, query: q, all_topics: !area && !q }));
      }
      setQuery('');
      await store.getState().refresh();
      store.getState().showSearch(started[0]!.id);
      if (started.length > 1) toast({ text: `${started.length} searches started — they run side by side; switch between them on the left.` });
    });
  };

  const checkNovelty = () => void run(async () => {
    const waiting = weekly.waiting;
    if (!waiting) return;
    const check = await clients.maintenance.check(waiting.checkId);
    setWeekly((w) => ({ ...w, waiting: null }));
    if (check.candidate_ids.length === 0) return;
    const started = await clients.explore.start({ candidate_ids: check.candidate_ids.slice(0, 100), channels: [] });
    await store.getState().refresh();
    store.getState().showSearch(started.id);
  });

  const topicAction = (action: 'rename' | 'merge' | 'pin', area: KbArea) => {
    if (action === 'pin') {
      void run(async () => {
        await clients.areas.update(area.id, { pinned: !area.pinned });
        setReloadKey((k) => k + 1);
        toast({ text: area.pinned ? 'Unpinned.' : 'Pinned: SKAZ searches this topic weekly.' });
      });
      return;
    }
    setEdit({ mode: action, area });
  };

  /** Discuss opens the chat the backend made from the paper's card — the chat itself, not the section behind it. */
  const discuss = (chatId: string) => {
    if (!services) return;
    const { prefs, ui, chats } = services;
    prefs.getState().set({ section: 'chats', sideOpen: true });
    if (ui.getState().docExpanded) ui.getState().toggleDocExpanded();
    ui.getState().showCenter('chat');
    void chats.getState().loadList();
    chats.getState().open(chatId);
  };

  /** FX-5: «Edit words and search again» starts the new run and opens it as this page's search. */
  const openStarted = async (id: string) => {
    await store.getState().refresh();
    store.getState().showSearch(id);
  };

  return (
    <main className="kb-ex" data-pane="explore" hidden={hidden}>
      <form className="kb-ex-bar" onSubmit={find} role="search">
        <div className="kb-ex-bar__field">
          <Icon name="search" size={14} />
          <span className="kb-ex-bar__scope" title={scopeLabel}>
            <span>{scopeLabel}</span>
            {!search && (nav.selected || nav.multi.length > 1) && (
              <button type="button" className="kb-ex-bar__clear" aria-label="Search all your topics"
                onClick={() => { store.getState().clearMulti(); store.getState().goToLevel(null, null); }}>
                <Icon name="close" size={12} />
              </button>
            )}
          </span>
          <input className="kb-ex-bar__input" aria-label="What exactly? (optional)" value={query} maxLength={200}
            placeholder="What exactly? Optional — e.g. evaluating RAG answers" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="submit" className="kb-ex-bar__go" disabled={busy}>
          {nav.multi.length > 1 && !search ? `Find in ${nav.multi.length} topics` : "Find what's new"}
        </button>
        {weekly.day && <span className="kb-ex-bar__note" title="Pinned topics, free steps only">Weekly · {weekly.day}</span>}
        {weekly.waiting && <span className="kb-ex-bar__note">
          {weekly.waiting.count} waiting · <button type="button" className="kb-ex-link" disabled={busy} onClick={checkNovelty}>Check novelty</button>
        </span>}
      </form>
      {issue && <div className="kb-ex-stop kb-ex-stop--page" role="alert"><span>{issue}</span>
        {/settings/i.test(issue) && <button type="button" className="kb-ex-link" onClick={() => openSettings('search')}>Open Settings</button>}
      </div>}
      {!search ? (
        <MapPage clients={clients} hidden={hidden} level={nav.level} selected={nav.selected} multi={nav.multi}
          searches={nav.searches} reloadKey={reloadKey} onLevel={(level, selected) => store.getState().goToLevel(level, selected)}
          onToggleMulti={(id) => store.getState().toggleMulti(id)} onClearMulti={() => store.getState().clearMulti()}
          onOpenSearch={(id) => store.getState().showSearch(id)} onOpenDocument={openDocument} onOpenSettings={openSettings}
          onTopicAction={topicAction} onMap={onMap} />
      ) : (
        <SearchPage key={search.id} search={search} scopeName={nameOf(search.area_id)} explore={clients.explore}
          parallelLimit={nav.parallelLimit} listWidth={listWidth}
          onListWidth={(px) => prefs.getState().setExploreListWidth(px)} onStarted={openStarted}
          covered={covered} onCovered={pageCover}
          onChanged={() => void store.getState().refresh()} onDiscuss={discuss} onOpenDocument={openDocument}
          onOpenSettings={openSettings} toast={toast} />
      )}
      {edit && <TopicDialog edit={edit} clients={clients} onClose={() => setEdit(null)} onSaved={(area, mode) => {
        if (mode === 'merge') store.getState().goToLevel(area.has_children ? area.id : area.parent_id, area.id);
        setReloadKey((k) => k + 1);
      }} />}
    </main>
  );
}
