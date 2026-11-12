import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useStore } from 'zustand';
import { KbApiError } from '../api/client';
import type {
  KbArea,
  KbFinding,
} from '../../api/kb/types.gen';
import { useServices, type KbServices } from '../state/context';
import type { DocTarget } from '../state/document';
import type { SettingsSection } from '../state/ui';
import { Button, Icon, IconButton, Menu } from '../ui';
import { AreaColumn } from './AreaColumn';
import { FindingClientsProvider } from './finding';
import { ExploreMap } from './ExploreMap';
import { CheckProgress } from './CheckProgress';
import { ScopePicker } from './ScopePicker';
import { SearchPlan } from './SearchPlan';
import { useSearchPlan } from './useSearchPlan';
import { TopicLabelling } from './TopicLabelling';
import { FunnelView } from './FunnelView';
import { TopicDialog, type TopicEdit } from './TopicDialog';
import { TOPICS_CHANGED } from './topicEvents';
import { exploreIssue, type ExploreIssue } from './errors';
import { useExploreScope } from './useExploreScope';
import { useExploreJobs } from './useExploreJobs';
import { weeklySelection } from './weeklySelection';
import './explore.css';
import { formatWikiShare, isGapArea } from './treemap';
import {
  STAGE_STEP,
  createExploreClients,
  type ExploreClients,
  type ExploreFindingStart,
  type ExploreResumeBody,
  type FindingToWikiBody,
  weekdayShort,
  type ExploreSectionProps,
} from './types';

function useOptionalServices(): KbServices | null {
  try {
    return useServices();
  } catch {
    return null;
  }
}

interface CrumbItem {
  id: string | null;
  name: string;
}

export function ExploreSection({
  hidden = false,
  clients: clientsProp,
  FindingComponent,
  initial,
  onOpenDocument: onOpenDocumentProp,
  onOpenSettings: onOpenSettingsProp,
}: ExploreSectionProps) {
  const services = useOptionalServices();

  const clients = useMemo<ExploreClients>(() => {
    if (clientsProp) return clientsProp;
    if (!services) throw new Error('ExploreSection needs KbServicesProvider or a clients prop');
    return createExploreClients(services.client);
  }, [clientsProp, services]);

  const handleOpenDocument = useCallback(
    (target: DocTarget) => {
      if (onOpenDocumentProp) {
        onOpenDocumentProp(target);
        return;
      }
      services?.ui.getState().openDocument(target);
    },
    [onOpenDocumentProp, services],
  );

  const handleOpenSettings = useCallback(
    (section?: SettingsSection) => {
      if (onOpenSettingsProp) {
        onOpenSettingsProp(section);
        return;
      }
      services?.ui.getState().openSettings(section);
    },
    [onOpenSettingsProp, services],
  );

  const handleOpenWiki = useCallback(() => {
    services?.prefs.getState().set({ section: 'wiki', sideOpen: true });
  }, [services]);

  const scope = useExploreScope(clients, initial);
  const { map, selectedTopic, materials, findings, activeTab, setActiveTab } = scope;
  const checkId = useStore(weeklySelection(services?.client), (s) => s.checkId);
  const jobs = useExploreJobs(clients, hidden, initial, checkId, scope.refresh);
  const { run, repeatCheck, weeklyCheck, exploringItems, waiting } = jobs;
  useEffect(() => {
    if (checkId && weeklyCheck?.id === checkId && ['done', 'cancelled', 'error'].includes(weeklyCheck.state)) {
      weeklySelection(services?.client).setState({ checkId: null });
    }
  }, [checkId, weeklyCheck, services?.client]);
  const weeklyDay = weekdayShort(jobs.weeklyDay);
  const [openFinding, setOpenFinding] = useState<KbFinding | null>(initial?.finding ?? null);
  const [keyHintDismissed, setKeyHintDismissed] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOverride, setSearchOverride] = useState<KbArea | null | undefined>();
  const [topicEdit, setTopicEdit] = useState<TopicEdit | null>(null);
  const [topicMenu, setTopicMenu] = useState(false);
  const topicMenuRef = useRef<HTMLButtonElement | null>(null);
  const [actionIssue, setActionIssue] = useState<ExploreIssue | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const perform = useCallback(async (action: () => Promise<void>, recover?: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    jobs.invalidate();
    setBusy(true); setActionIssue(null);
    try { await action(); }
    catch (error) {
      if (mounted.current) setActionIssue(exploreIssue(error));
      if (error instanceof KbApiError && error.code === 'conflict') {
        try { await recover?.(); } catch { /* The visible conflict remains until a successful refresh. */ }
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }, [jobs.invalidate]);

  const currentMapArea = useMemo<KbArea | null>(() => {
    if (!map || !map.parent_id) return null;
    return map.breadcrumbs[map.breadcrumbs.length - 1] ?? null;
  }, [map]);

  const activeScopeArea = selectedTopic ?? currentMapArea;
  const scopeId = activeScopeArea?.id ?? map?.parent_id ?? null;
  const scopeName = activeScopeArea?.name ?? 'All your topics';
  const searchArea = searchOverride === undefined ? activeScopeArea : searchOverride;
  const searchRequest = useMemo(() => ({ area_id: searchArea?.id ?? null, query: query.trim(), all_topics: !searchArea && !query.trim() }), [searchArea?.id, query]);
  const searchPlan = useSearchPlan(clients.discovery, searchRequest, hidden);
  const isRootScope = scopeId === null;
  const scopePages = activeScopeArea?.pages ?? map?.total_pages ?? 0;
  const sourcesCount = activeScopeArea?.materials ?? map?.total_sources ?? 0;

  useEffect(() => {
    if (hidden || !map || !['running', 'paused'].includes(map.labelling.state)) return;
    const timer = window.setInterval(() => void scope.refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [hidden, map?.labelling.state, scope.refresh]);

  useEffect(() => {
    const changed = () => void scope.refresh();
    window.addEventListener(TOPICS_CHANGED, changed);
    return () => window.removeEventListener(TOPICS_CHANGED, changed);
  }, [scope.refresh]);

  const handleSortTopics = () => perform(async () => {
    if (!clients.topics) throw new KbApiError(503, '', 'not_ready');
    scope.saveLabelling(await clients.topics.sort());
  });

  const navigateToParent = useCallback(async (parentId: string | null) => {
    setOpenFinding(null); setSearchOverride(undefined);
    await scope.load(parentId);
  }, [scope.load]);

  const handleSelectAreaTile = useCallback(async (area: KbArea) => {
    setOpenFinding(null); setSearchOverride(undefined);
    void clients.areas.opened(area.id).catch((error) => setActionIssue(exploreIssue(error)));
    if (area.has_children && !isGapArea(area)) await scope.load(area.id);
    else await scope.load(map?.parent_id ?? null, area);
  }, [clients, map, scope.load]);

  const breadcrumbs = useMemo<CrumbItem[]>(() => {
    const items: CrumbItem[] = [{ id: null, name: 'Explore' }];
    for (const b of map?.breadcrumbs ?? []) {
      items.push({ id: b.id, name: b.name });
    }
    if (selectedTopic) {
      items.push({ id: selectedTopic.id, name: selectedTopic.name });
    }
    return items;
  }, [map, selectedTopic]);

  const visibleCrumbs = useMemo<CrumbItem[]>(() => {
    if (breadcrumbs.length <= 4) return breadcrumbs;
    return [
      breadcrumbs[0]!,
      { id: breadcrumbs[breadcrumbs.length - 3]!.id, name: '…' },
      ...breadcrumbs.slice(-2),
    ];
  }, [breadcrumbs]);

  const handleUpLevel = useCallback(() => {
    if (selectedTopic) { void navigateToParent(map?.parent_id ?? null); return; }
    if (!map || map.breadcrumbs.length === 0) return;
    const parentCrumb = map.breadcrumbs.length >= 2 ? map.breadcrumbs[map.breadcrumbs.length - 2]! : null;
    void navigateToParent(parentCrumb?.id ?? null);
  }, [map, navigateToParent, selectedTopic]);

  const handleStartSearch = (e?: FormEvent) => {
    e?.preventDefault();
    if (!searchPlan.ready || scope.loading) return;
    return perform(async () => {
      const started = await clients.explore.start({ ...searchRequest, plan: searchPlan.items });
      setOpenFinding(null); jobs.setRun(started);
    });
  };

  const handleCheckNovelty = () => perform(async () => {
    if (!waiting) return;
    const check = await clients.maintenance.check(waiting.checkId);
    if (check.candidate_ids.length === 0) { jobs.setWaiting(null); return; }
    const started = await clients.explore.start({ candidate_ids: check.candidate_ids.slice(0, 100), channels: [] });
    jobs.setWaiting(null); setOpenFinding(null); jobs.setRun(started);
  });

  const recoverRun = async () => { if (run) jobs.setRun(await clients.explore.run(run.id)); };
  const handleStopSearch = () => perform(async () => {
    if (run) jobs.setRun(await clients.explore.pause(run.id));
  }, recoverRun);

  const handleResumeRun = (answer?: ExploreResumeBody) => perform(async () => {
    if (!run) return;
    const latest = await clients.explore.run(run.id);
    if (latest.state !== 'paused' || !latest.checkpoint) { jobs.setRun(latest); return; }
    jobs.setRun(await clients.explore.resume(run.id, {
      checkpoint_id: latest.checkpoint.id, revision: latest.checkpoint.revision, ...answer,
    }));
  }, recoverRun);

  const handleCancelRun = () => perform(async () => {
    if (run) jobs.setRun(await clients.explore.cancel(run.id));
  }, recoverRun);

  const handleDismissKeyHint = () => perform(async () => {
    await clients.science.dismiss_hint(); setKeyHintDismissed(true);
  });

  const handleStartRepeats = () => perform(async () => {
    if (scopeId) jobs.setRepeatCheck(await clients.repeats.start({ area_id: scopeId }));
  });
  const recoverRepeats = async () => { if (repeatCheck) jobs.setRepeatCheck(await clients.repeats.check(repeatCheck.id)); };
  const handlePauseRepeats = () => perform(async () => {
    if (repeatCheck) jobs.setRepeatCheck(await clients.repeats.pause(repeatCheck.id));
  }, recoverRepeats);
  const handleResumeRepeats = (choice?: ExploreResumeBody['decision_choice']) => perform(async () => {
    if (!repeatCheck) return;
    const latest = await clients.repeats.check(repeatCheck.id);
    if (latest.state !== 'paused' || !latest.checkpoint) { jobs.setRepeatCheck(latest); return; }
    jobs.setRepeatCheck(await clients.repeats.resume(latest.id, {
      checkpoint_id: latest.checkpoint.id, revision: latest.checkpoint.revision,
      ...(choice ? { decision_choice: choice } : {}),
    }));
  }, recoverRepeats);

  const recoverWeekly = async () => { if (weeklyCheck) jobs.setWeeklyCheck(await clients.maintenance.check(weeklyCheck.id)); };
  const handlePauseWeekly = () => perform(async () => {
    if (weeklyCheck) jobs.setWeeklyCheck(await clients.maintenance.pause(weeklyCheck.id));
  }, recoverWeekly);
  const handleResumeWeekly = (choice?: ExploreResumeBody['decision_choice']) => perform(async () => {
    if (!weeklyCheck) return;
    const latest = await clients.maintenance.check(weeklyCheck.id);
    if (latest.state !== 'paused' || !latest.checkpoint) { jobs.setWeeklyCheck(latest); return; }
    jobs.setWeeklyCheck(await clients.maintenance.resume(latest.id, {
      checkpoint_id: latest.checkpoint.id, revision: latest.checkpoint.revision,
      ...(choice ? { decision_choice: choice } : {}),
    }));
  }, recoverWeekly);

  const handlePin = () => perform(async () => {
    if (!activeScopeArea) return;
    scope.saveArea(await clients.areas.update(activeScopeArea.id, { pinned: !activeScopeArea.pinned }));
  });

  const handleExploreFinding = useCallback(async (findingId: string, body: ExploreFindingStart) => {
    const session = await clients.explore.explore(findingId, body);
    jobs.setExploringItems((prev) => prev.some((item) => item.id === session.id) ? prev : [session, ...prev]);
    return session;
  }, [clients, jobs.setExploringItems]);

  const handleAddToWiki = useCallback(async (findingId: string, body: FindingToWikiBody) => {
    await clients.explore.add_to_wiki(findingId, body);
  }, [clients]);

  const findingClients = useMemo(
    () => ({ explore: clients.explore, areas: clients.areas, science: clients.science }),
    [clients],
  );
  const isScanning = run?.state === 'running';
  const isJustDone = run?.state === 'done';

  return (
    <FindingClientsProvider clients={findingClients}>
      <main className="kb-explore" data-pane="explore" hidden={hidden}>
        <header className="kb-explore-head">
          <nav className="kb-explore-crumbs" aria-label="Explore breadcrumbs">
            {breadcrumbs.length > 1 && (
              <button
                type="button"
                className="kb-explore-icon-btn"
                title="Up a level"
                aria-label="Up a level"
                onClick={handleUpLevel}
              >
                <Icon name="chevronLeft" size={14} />
              </button>
            )}
            {visibleCrumbs.map((crumb, idx) => {
              const isLast = idx === visibleCrumbs.length - 1;
              if (isLast) {
                return (
                  <strong key={`${crumb.id ?? 'root'}-${idx}`} className="kb-explore-crumbs__current">
                    {crumb.name}
                  </strong>
                );
              }
              return (
                <span key={`${crumb.id ?? 'root'}-${idx}`} className="kb-explore-crumbs__step">
                  <button
                    type="button"
                    className="kb-explore-crumbs__btn"
                    onClick={() => void navigateToParent(crumb.id)}
                  >
                    {crumb.name}
                  </button>
                  <Icon name="chevronRight" size={14} />
                </span>
              );
            })}
          </nav>

          {activeScopeArea && (
            <>
              <span className="kb-explore-head__meta">
                {formatWikiShare(activeScopeArea.wiki_share)} of your wiki
              </span>
              <IconButton ref={topicMenuRef} icon="more" label="Topic actions" aria-haspopup="menu" aria-expanded={topicMenu} disabled={busy} onClick={() => setTopicMenu((old) => !old)} />
              <Menu open={topicMenu} onClose={() => setTopicMenu(false)} anchorRef={topicMenuRef} label="Topic actions" items={[
                { id: 'rename', label: 'Rename topic', icon: 'pencil', onSelect: () => setTopicEdit({ mode: 'rename', area: activeScopeArea }) },
                { id: 'merge', label: 'Merge into another topic…', onSelect: () => setTopicEdit({ mode: 'merge', area: activeScopeArea }) },
                { id: 'pin', label: activeScopeArea.pinned ? 'Unpin topic' : 'Pin topic', note: 'For weekly discovery', onSelect: () => void handlePin() },
                { id: 'subtopic', label: 'New subtopic', icon: 'plus', onSelect: () => setTopicEdit({ mode: 'create', area: null, parentId: activeScopeArea.id }) },
              ]} />
            </>
          )}

          <Button variant="quiet" size="sm" icon="plus" disabled={!map || scope.loading || busy} onClick={() => setTopicEdit({ mode: 'create', area: null })}>New topic</Button>
          <div className="kb-explore-head__spacer" />

          <span className="kb-explore-head__meta" title="Findings you took to explore">
            Exploring · {exploringItems.length}
          </span>
        </header>

        {[actionIssue, scope.issue, jobs.issue].filter((issue): issue is ExploreIssue => issue !== null).map((issue, index) => (
          <div key={index} className="kb-explore-stop-box" role="alert">
            <p>{issue.message}{scope.issue === issue && findings ? ' The results shown may be out of date.' : ''}</p>
            {issue.settings && <button type="button" className="kb-explore-btn" onClick={() => handleOpenSettings('search')}>Open Settings</button>}
            {scope.issue === issue && <button type="button" className="kb-explore-btn" onClick={() => void (findings ? scope.refresh() : scope.retry())}>Try again</button>}
          </div>
        ))}
        <div className="kb-explore-search">
          {isScanning && run ? (
            <div className="kb-explore-search__field is-running">
              <Icon name="retry" size={14} className="kb-explore-spin" />
              <span className="kb-explore-search__status">
                Finding what&apos;s new in <strong>{scopeName}</strong> · step{' '}
                {STAGE_STEP[run.stage] ?? 1} of 5
              </span>
              <button
                type="button"
                className="kb-explore-search__go"
                disabled={busy}
                onClick={() => void handleStopSearch()}
              >
                Stop
              </button>
            </div>
          ) : (
            <>
              <form className="kb-explore-search__field" onSubmit={(e) => void handleStartSearch(e)}>
                <Icon name="search" size={14} />
                <ScopePicker clients={clients} value={searchArea} onChange={setSearchOverride} onQuery={setQuery} disabled={busy} />
                <input
                  type="text"
                  aria-label="Precise query"
                  className="kb-explore-search__input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="What exactly? Optional — e.g. evaluating RAG answers"
                />
                <button type="submit" className="kb-explore-search__go" disabled={busy || scope.loading || !searchPlan.ready}>
                  Find what&apos;s new
                </button>
              </form>
              {weeklyDay && (
                <span className="kb-explore-search__week" title="Pinned topics, free steps only">
                  Weekly · {weeklyDay}
                </span>
              )}
              {waiting && (
                <span className="kb-explore-search__week">
                  {waiting.count} {waiting.count === 1 ? 'candidate' : 'candidates'} waiting ·{' '}
                  <button type="button" className="kb-link" onClick={() => void handleCheckNovelty()}>
                    Check novelty
                  </button>
                </span>
              )}
            </>
          )}
        </div>

        {!isScanning && <SearchPlan items={searchPlan.items} message={searchPlan.message} failed={searchPlan.failed}
          onRetry={searchPlan.retry} onChange={searchPlan.edit} disabled={busy} />}
        {map && <TopicLabelling job={map.labelling} unsorted={map.unsorted_materials} busy={busy}
          onSort={() => void handleSortTopics()} onSettings={handleOpenSettings} />}
        {run && <FunnelView key={run.id} run={run} client={clients.discovery} hidden={hidden} busy={busy}
          onCheckNovelty={(candidateIds) => void perform(async () => {
            jobs.setRun(await clients.explore.start({ candidate_ids: candidateIds, channels: [] }));
          })} />}
        {repeatCheck && <CheckProgress kind="repeat" job={repeatCheck} busy={busy}
          onPause={() => void handlePauseRepeats()} onResume={(choice) => void handleResumeRepeats(choice)}
          onOpenSettings={() => handleOpenSettings('search')} />}
        {weeklyCheck && <CheckProgress kind="weekly" job={weeklyCheck} busy={busy}
          onPause={() => void handlePauseWeekly()} onResume={(choice) => void handleResumeWeekly(choice)}
          onOpenSettings={() => handleOpenSettings('search')} />}
        <div className="kb-explore-body" aria-busy={scope.loading}>
          {map && <ExploreMap
            scopeKey={map.parent_id}
            areas={map?.areas ?? []}
            parentPages={currentMapArea?.pages ?? map?.total_pages ?? 0}
            selectedAreaId={selectedTopic?.id ?? null}
            scanning={Boolean(isScanning)}
            activeAreaIds={run?.active_area_ids ?? []}
            justDone={Boolean(isJustDone)}
            onSelectArea={(area) => void handleSelectAreaTile(area)}
          />}

          {scope.loading ? <p className="kb-explore-cap" role="status">Loading topics…</p> : (scope.issue && !findings) || (map?.labelling.state === 'not_ready' && map.areas.length === 0 && !run) ? null : <AreaColumn
            busy={busy}
            loadingMore={scope.loadingMore}
            onLoadMoreFindings={() => void scope.loadMore('findings')}
            onLoadMoreMaterials={() => void scope.loadMore('materials')}
            scopeName={scopeName}
            isRootScope={isRootScope}
            scopePages={scopePages}
            sourcesCount={sourcesCount}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            materials={materials}
            findings={findings}
            worthClosing={map?.worth_closing ?? []}
            run={run}
            repeatCheck={repeatCheck}
            keyHintDismissed={keyHintDismissed}
            onDismissKeyHint={() => void handleDismissKeyHint()}
            onResumeRun={(body) => void handleResumeRun(body)}
            onCancelRun={() => void handleCancelRun()}
            onStartRepeats={() => void handleStartRepeats()}
            openFinding={openFinding}
            onOpenFinding={(f) => setOpenFinding(f)}
            onCloseFinding={() => setOpenFinding(null)}
            onExploreFinding={handleExploreFinding}
            onAddToWiki={handleAddToWiki}
            onSelectWorthClosing={(area) => void handleSelectAreaTile(area)}
            FindingComponent={FindingComponent}
            onOpenDocument={handleOpenDocument}
            onOpenSettings={handleOpenSettings}
            onOpenWiki={handleOpenWiki}
          />}
        </div>
        {topicEdit && <TopicDialog edit={topicEdit} clients={clients} onClose={() => setTopicEdit(null)} onSaved={(area, mode) => {
          if (mode === 'rename') { scope.saveArea(area); setSearchOverride((old) => old?.id === area.id ? area : old); }
          else if (mode === 'merge') {
            setSearchOverride(undefined);
            void scope.load(area.has_children ? area.id : area.parent_id, area.has_children ? undefined : area);
          } else void scope.refresh();
        }} />}
      </main>
    </FindingClientsProvider>
  );
}
