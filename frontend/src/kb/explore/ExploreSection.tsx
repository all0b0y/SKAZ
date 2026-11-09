import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  KbArea,
  KbAreaMap,
  KbAreaMaterials,
  KbExploring,
  KbFinding,
  KbFindings,
  KbFunnelRun,
  KbRepeatCheck,
} from '../../api/kb/types.gen';
import { useServices, type KbServices } from '../state/context';
import type { DocTarget } from '../state/document';
import type { SettingsSection } from '../state/ui';
import { Icon } from '../ui';
import { AreaColumn } from './AreaColumn';
import { ExploreMap } from './ExploreMap';
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

  const [map, setMap] = useState<KbAreaMap | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<KbArea | null>(null);
  const [activeTab, setActiveTab] = useState<'materials' | 'new'>('new');
  const [materials, setMaterials] = useState<KbAreaMaterials | null>(null);
  const [findings, setFindings] = useState<KbFindings | null>(null);
  const [run, setRun] = useState<KbFunnelRun | null>(initial?.run ?? null);
  const [repeatCheck, setRepeatCheck] = useState<KbRepeatCheck | null>(initial?.repeatCheck ?? null);
  const [openFinding, setOpenFinding] = useState<KbFinding | null>(initial?.finding ?? null);
  const [exploringItems, setExploringItems] = useState<KbExploring[]>([]);
  const [keyHintDismissed, setKeyHintDismissed] = useState(false);
  const [weeklyDay, setWeeklyDay] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const runRef = useRef<KbFunnelRun | null>(null);
  runRef.current = run;

  // Initial load: the top level of the map, the findings, what is already being explored, and a search
  // that is still running (the section may be opened while one is in progress).
  useEffect(() => {
    let cancelled = false;
    const loadInitial = async () => {
      try {
        const mapRes = await clients.areas.map(initial?.parentId ? { parent_id: initial.parentId } : {});
        const [findingsRes, exploringRes, jobsRes] = await Promise.all([
          clients.explore.findings(mapRes.parent_id ? { area_id: mapRes.parent_id } : {}),
          clients.explore.exploring(),
          clients.explore.jobs({ active: true }),
        ]);
        if (cancelled) return;
        setMap(mapRes);
        setFindings(findingsRes);
        setExploringItems(exploringRes.items);
        void clients.maintenance
          .settings()
          .then((w) => {
            if (!cancelled) setWeeklyDay(w.enabled ? weekdayShort(w.next_due_at) : null);
          })
          .catch(() => undefined);

        const exploreJob = jobsRes.jobs.find((j) => j.owner === 'explore');
        if (exploreJob) {
          const activeRun = await clients.explore.run(exploreJob.id);
          if (!cancelled) setRun(activeRun);
        }

        const topic = initial?.topicId ? mapRes.areas.find((a) => a.id === initial.topicId) : undefined;
        const materialsAreaId = topic?.id ?? mapRes.parent_id;
        // The contract has no "all areas" materials route, so the top level shows none.
        if (materialsAreaId) {
          const matRes = await clients.areas.materials(materialsAreaId).catch(() => null);
          if (cancelled) return;
          if (matRes) setMaterials(matRes);
        }
        if (topic) {
          setSelectedTopic(topic);
          setActiveTab('materials');
        }
      } catch {
        // The bridge failed; the section stays empty rather than showing a half state.
      }
    };
    void loadInitial();
    return () => {
      cancelled = true;
    };
    // `initial` seeds the first load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients]);

  // Poll explore.jobs({ active: true }) ~1/s while visible
  useEffect(() => {
    if (hidden) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const jobsRes = await clients.explore.jobs({ active: true });
          const currentRun = runRef.current;
          const exploreJob = jobsRes.jobs.find((j) => j.owner === 'explore');
          if (exploreJob) {
            const latest = await clients.explore.run(exploreJob.id);
            setRun(latest);
          } else if (currentRun?.state === 'running') {
            const latest = await clients.explore.run(currentRun.id);
            setRun(latest);
          }
        } catch {
          // Ignore transient poll errors
        }
      })();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [clients, hidden]);

  const currentMapArea = useMemo<KbArea | null>(() => {
    if (!map || !map.parent_id) return null;
    return map.breadcrumbs[map.breadcrumbs.length - 1] ?? null;
  }, [map]);

  const activeScopeArea = selectedTopic ?? currentMapArea;
  const scopeId = activeScopeArea?.id ?? map?.parent_id ?? null;
  const scopeName = activeScopeArea?.name ?? 'all your areas';
  const isRootScope = scopeId === null;
  const scopePages = activeScopeArea?.pages ?? map?.total_pages ?? 0;
  const sourcesCount = activeScopeArea?.sources ?? map?.total_sources ?? 0;

  const navigateToParent = useCallback(
    async (parentId: string | null, clickedArea?: KbArea) => {
      setOpenFinding(null);
      setSelectedTopic(null);
      setActiveTab('new');
      if (clickedArea) {
        void clients.areas.opened(clickedArea.id);
      }
      const [nextMap, nextFindings, nextMaterials] = await Promise.all([
        clients.areas.map(parentId ? { parent_id: parentId } : {}),
        clients.explore.findings(parentId ? { area_id: parentId } : {}),
        parentId ? clients.areas.materials(parentId).catch(() => null) : Promise.resolve(null),
      ]);
      setMap(nextMap);
      setFindings(nextFindings);
      setMaterials(nextMaterials);
    },
    [clients],
  );

  const handleSelectAreaTile = useCallback(
    async (area: KbArea) => {
      setOpenFinding(null);
      void clients.areas.opened(area.id);

      if (area.has_children && !isGapArea(area)) {
        await navigateToParent(area.id, undefined);
        return;
      }

      // Leaf topic or gap tile: select in place and switch to Your materials (or New for 0-page gap)
      setSelectedTopic(area);
      setActiveTab(isGapArea(area) ? 'new' : 'materials');
      const [matRes, findingsRes] = await Promise.all([
        clients.areas.materials(area.id).catch(() => null),
        clients.explore.findings({ area_id: area.id }).catch(() => null),
      ]);
      if (matRes) setMaterials(matRes);
      if (findingsRes) setFindings(findingsRes);
    },
    [clients, navigateToParent],
  );

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
    if (selectedTopic) {
      setSelectedTopic(null);
      setActiveTab('new');
      return;
    }
    if (!map || map.breadcrumbs.length === 0) return;
    const parentCrumb =
      map.breadcrumbs.length >= 2 ? map.breadcrumbs[map.breadcrumbs.length - 2]! : null;
    void navigateToParent(parentCrumb?.id ?? null);
  }, [map, navigateToParent, selectedTopic]);

  const handleStartSearch = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const trimmed = query.trim();
      const started = await clients.explore.start({
        area_id: scopeId,
        ...(trimmed.length > 0 ? { query: trimmed } : {}),
      });
      setOpenFinding(null);
      setRun(started);
    },
    [clients, query, scopeId],
  );

  const handleStopSearch = useCallback(async () => {
    if (!run) return;
    const paused = await clients.explore.pause(run.id);
    setRun(paused);
  }, [clients, run]);

  const handleResumeRun = useCallback(
    async (answer?: ExploreResumeBody) => {
      if (!run?.checkpoint) return;
      const resumed = await clients.explore.resume(run.id, {
        checkpoint_id: run.checkpoint.id,
        revision: run.checkpoint.revision,
        ...answer,
      });
      setRun(resumed);
    },
    [clients, run],
  );

  const handleCancelRun = useCallback(async () => {
    if (!run) return;
    const cancelled = await clients.explore.cancel(run.id);
    setRun(cancelled);
  }, [clients, run]);

  const handleDismissKeyHint = useCallback(async () => {
    setKeyHintDismissed(true);
    await clients.science.dismiss_hint();
  }, [clients]);

  const handleStartRepeats = useCallback(async () => {
    if (!scopeId) return;
    const job = await clients.repeats.start({ area_id: scopeId });
    setRepeatCheck(job);
  }, [clients, scopeId]);

  const handlePauseRepeats = useCallback(async () => {
    if (!repeatCheck) return;
    const paused = await clients.repeats.pause(repeatCheck.id);
    setRepeatCheck(paused);
  }, [clients, repeatCheck]);

  const handleResumeRepeats = useCallback(async () => {
    if (!repeatCheck?.checkpoint) return;
    const resumed = await clients.repeats.resume(repeatCheck.id, {
      checkpoint_id: repeatCheck.checkpoint.id,
      revision: repeatCheck.checkpoint.revision,
    });
    setRepeatCheck(resumed);
  }, [clients, repeatCheck]);

  const handleExploreFinding = useCallback(
    async (findingId: string, body: ExploreFindingStart) => {
      const session = await clients.explore.explore(findingId, body);
      setExploringItems((prev) =>
        prev.some((item) => item.id === session.id) ? prev : [session, ...prev],
      );
      return session;
    },
    [clients],
  );

  const handleAddToWiki = useCallback(
    async (findingId: string, body: FindingToWikiBody) => {
      await clients.explore.add_to_wiki(findingId, body);
    },
    [clients],
  );

  const isScanning = run?.state === 'running';
  const isJustDone = run?.state === 'done';

  return (
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
          <span className="kb-explore-head__meta">
            {formatWikiShare(activeScopeArea.wiki_share)} of your wiki
          </span>
        )}

        <div className="kb-explore-head__spacer" />

        <span className="kb-explore-head__meta" title="Findings you took to explore">
          Exploring · {exploringItems.length}
        </span>
      </header>

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
              onClick={() => void handleStopSearch()}
            >
              Stop
            </button>
          </div>
        ) : (
          <>
            <form className="kb-explore-search__field" onSubmit={(e) => void handleStartSearch(e)}>
              <Icon name="search" size={14} />
              <span
                className="kb-explore-search__scope"
                title="Where to look — follows the area you open"
              >
                in {scopeName}
              </span>
              <input
                type="text"
                className="kb-explore-search__input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="What exactly? Optional — e.g. evaluating RAG answers"
              />
              <button type="submit" className="kb-explore-search__go">
                Find what&apos;s new
              </button>
            </form>
            {weeklyDay && (
              <span className="kb-explore-search__week" title="Pinned areas, free steps only">
                Weekly · {weeklyDay}
              </span>
            )}
          </>
        )}
      </div>

      <div className="kb-explore-body">
        <ExploreMap
          areas={map?.areas ?? []}
          parentPages={currentMapArea?.pages ?? map?.total_pages ?? 0}
          selectedAreaId={selectedTopic?.id ?? null}
          scanning={Boolean(isScanning)}
          activeAreaIds={run?.active_area_ids ?? []}
          justDone={Boolean(isJustDone)}
          onSelectArea={(area) => void handleSelectAreaTile(area)}
        />

        <AreaColumn
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
          onPauseRepeats={() => void handlePauseRepeats()}
          onResumeRepeats={() => void handleResumeRepeats()}
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
        />
      </div>
    </main>
  );
}
