import { useCallback, useEffect, useRef, useState } from 'react';
import type { KbArea, KbAreaMap, KbAreaMaterials, KbFindings } from '../../api/kb/types.gen';
import { exploreIssue, type ExploreIssue } from './errors';
import { isGapArea } from './treemap';
import type { ExploreClients, ExploreInitialState } from './types';

function appendFindings(first: KbFindings, next: KbFindings): KbFindings {
  const groups = first.groups.map((g) => ({ ...g, findings: [...g.findings] }));
  for (const group of next.groups) {
    const existing = groups.find((g) => g.task_id === group.task_id);
    if (!existing) groups.push({ ...group, findings: [...group.findings] });
    else {
      const ids = new Set(existing.findings.map((f) => f.id));
      existing.findings.push(...group.findings.filter((f) => !ids.has(f.id)));
    }
  }
  return { ...next, groups };
}

function appendMaterials(first: KbAreaMaterials, next: KbAreaMaterials): KbAreaMaterials {
  const ids = new Set(first.materials.map((m) => m.material_id));
  return { ...next, materials: [...first.materials, ...next.materials.filter((m) => !ids.has(m.material_id))] };
}

/** Scope changes and refreshes share one request generation, including pagination. */
export function useExploreScope(clients: ExploreClients, initial?: ExploreInitialState) {
  const seed = useRef(initial);
  const [map, setMap] = useState<KbAreaMap | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<KbArea | null>(null);
  const [materials, setMaterials] = useState<KbAreaMaterials | null>(null);
  const [findings, setFindings] = useState<KbFindings | null>(null);
  const [activeTab, setActiveTab] = useState<'materials' | 'new'>('new');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [issue, setIssue] = useState<ExploreIssue | null>(null);
  const request = useRef(0);
  const current = useRef({ parentId: seed.current?.parentId ?? null as string | null, areaId: null as string | null });
  const mapRef = useRef(map); mapRef.current = map;
  const pages = useRef({ findings: 1, materials: 1 });
  const morePending = useRef(false);
  const navigating = useRef(false);
  const refreshPending = useRef(false);
  const lastLoad = useRef<{ parentId: string | null; topic?: KbArea | string }>({ parentId: seed.current?.parentId ?? null, topic: seed.current?.topicId });
  const writeVersion = useRef(0);
  const pins = useRef(new Map<string, { version: number; pinned: boolean }>());
  const reconcileMap = useCallback((nextMap: KbAreaMap, readVersion: number): KbAreaMap => {
    const reconcile = (items: KbArea[]) => items.map((area) => {
      const saved = pins.current.get(area.id);
      return saved && saved.version > readVersion ? { ...area, pinned: saved.pinned } : area;
    });
    return { ...nextMap, areas: reconcile(nextMap.areas), breadcrumbs: reconcile(nextMap.breadcrumbs), worth_closing: reconcile(nextMap.worth_closing) };
  }, []);

  const readFindings = useCallback(async (areaId: string | null, count: number) => {
    let result = await clients.explore.findings(areaId ? { area_id: areaId } : {});
    const seen = new Set<string>();
    for (let page = 1; page < count && result.next_cursor; page++) {
      const cursor = result.next_cursor;
      if (seen.has(cursor)) throw new Error('Repeated findings cursor');
      seen.add(cursor);
      result = appendFindings(result, await clients.explore.findings({ ...(areaId ? { area_id: areaId } : {}), cursor }));
    }
    return result;
  }, [clients]);

  const readMaterials = useCallback(async (areaId: string | null, count: number) => {
    if (!areaId) return null;
    let result = await clients.areas.materials(areaId);
    const seen = new Set<string>();
    for (let page = 1; page < count && result.next_cursor; page++) {
      const cursor = result.next_cursor;
      if (seen.has(cursor)) throw new Error('Repeated materials cursor');
      seen.add(cursor);
      result = appendMaterials(result, await clients.areas.materials(areaId, { cursor }));
    }
    return result;
  }, [clients]);

  const load = useCallback(async (parentId: string | null, topic?: KbArea | string) => {
    lastLoad.current = { parentId, topic };
    const id = ++request.current;
    const mapVersion = writeVersion.current;
    navigating.current = true;
    pages.current = { findings: 1, materials: 1 };
    morePending.current = false;
    setLoadingMore(false);
    setLoading(true); setIssue(null); setMaterials(null); setFindings(null);
    setSelectedTopic(typeof topic === 'object' ? topic : null);
    setActiveTab(topic && !(typeof topic === 'object' && isGapArea(topic)) ? 'materials' : 'new');
    current.current = { parentId, areaId: typeof topic === 'object' ? topic.id : parentId };
    const retainedMap = typeof topic === 'object' ? mapRef.current : null;
    if (!retainedMap) setMap(null);
    try {
      const nextMap = reconcileMap(retainedMap ?? await clients.areas.map(parentId ? { parent_id: parentId } : {}), mapVersion);
      if (id !== request.current) return;
      const leaf = typeof topic === 'string' ? nextMap.areas.find((a) => a.id === topic) : topic;
      const areaId = leaf?.id ?? nextMap.parent_id;
      current.current = { parentId: nextMap.parent_id, areaId };
      setMap(nextMap); setSelectedTopic(leaf ?? null);
      const [nextFindings, nextMaterials] = await Promise.all([readFindings(areaId, 1), readMaterials(areaId, 1)]);
      if (id !== request.current) return;
      setFindings(nextFindings); setMaterials(nextMaterials);
    } catch (error) {
      if (id === request.current) { refreshPending.current = false; setIssue(exploreIssue(error)); }
    } finally { if (id === request.current) { navigating.current = false; setLoading(false); } }
  }, [clients, readFindings, readMaterials, reconcileMap]);

  useEffect(() => {
    void load(seed.current?.parentId ?? null, seed.current?.topicId);
    return () => { request.current++; };
  }, [load]);

  const refresh = useCallback(async () => {
    if (morePending.current || navigating.current) { refreshPending.current = true; return; }
    refreshPending.current = false;
    const id = ++request.current;
    const mapVersion = writeVersion.current;
    const { parentId, areaId } = current.current;
    try {
      const [nextMap, nextFindings, nextMaterials] = await Promise.all([
        clients.areas.map(parentId ? { parent_id: parentId } : {}),
        readFindings(areaId, pages.current.findings), readMaterials(areaId, pages.current.materials),
      ]);
      if (id !== request.current) return;
      const reconciled = reconcileMap(nextMap, mapVersion);
      setMap(reconciled); setFindings(nextFindings); setMaterials(nextMaterials); setIssue(null);
      setSelectedTopic((topic) => topic ? reconciled.areas.find((a) => a.id === topic.id) ?? topic : null);
    } catch (error) { if (id === request.current) setIssue(exploreIssue(error)); }
    finally { if (id === request.current) setLoading(false); }
  }, [clients, readFindings, readMaterials, reconcileMap]);

  useEffect(() => {
    if (!loading && !loadingMore && refreshPending.current) void refresh();
  }, [loading, loadingMore, refresh]);

  const loadMore = useCallback(async (kind: 'findings' | 'materials') => {
    const cursor = kind === 'findings' ? findings?.next_cursor : materials?.next_cursor;
    const areaId = current.current.areaId;
    if (!cursor || morePending.current || (kind === 'materials' && !areaId)) return;
    const id = ++request.current;
    morePending.current = true; setLoadingMore(true); setIssue(null);
    try {
      if (kind === 'findings') {
        const next = await clients.explore.findings({ ...(areaId ? { area_id: areaId } : {}), cursor });
        if (id !== request.current) return;
        setFindings((old) => old ? appendFindings(old, next) : next);
      } else {
        const next = await clients.areas.materials(areaId!, { cursor });
        if (id !== request.current) return;
        setMaterials((old) => old ? appendMaterials(old, next) : next);
      }
      pages.current[kind]++;
    } catch (error) { if (id === request.current) setIssue(exploreIssue(error)); }
    finally { if (id === request.current) { morePending.current = false; setLoadingMore(false); } }
  }, [clients, findings, materials]);

  const saveArea = useCallback((area: KbArea) => {
    pins.current.set(area.id, { version: ++writeVersion.current, pinned: area.pinned });
    const replace = (items: KbArea[]) => items.map((item) => item.id === area.id ? area : item);
    setMap((old) => old ? { ...old, areas: replace(old.areas), breadcrumbs: replace(old.breadcrumbs), worth_closing: replace(old.worth_closing) } : old);
    setSelectedTopic((old) => old?.id === area.id ? area : old);
  }, []);

  const retry = useCallback(() => load(lastLoad.current.parentId, lastLoad.current.topic), [load]);
  return { map, selectedTopic, materials, findings, activeTab, setActiveTab, loading, loadingMore, issue, load, retry, refresh, loadMore, saveArea };
}
