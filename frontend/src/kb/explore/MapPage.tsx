import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type MutableRefObject } from 'react';
import type { KbArea, KbAreaMap, KbAreaMaterial, KbSearch } from '../../api/kb/types.gen';
import type { DocTarget } from '../state/document';
import type { SettingsSection } from '../state/ui';
import { Button, Icon, IconButton, Menu } from '../ui';
import { exploreIssue } from './errors';
import { searchStatus } from './exploreState';
import { TopicLabelling } from './TopicLabelling';
import { squarify } from './treemap';
import type { ExploreClients } from './types';

interface Tile {
  key: string;
  weight: number;
  name: string;
  concepts: number;
  materials: number;
  unseen: number;
  pinned: boolean;
  area: KbArea | null;
}

const MIN_WEIGHT = 8;

/** Up to nine tiles that each hold ≥ 4 % of the level; the rest share one «Other · N topics» tile. */
function splitLevel(areas: KbArea[]): { big: KbArea[]; small: KbArea[] } {
  const sorted = [...areas].sort((a, b) => (b.concepts ?? 0) - (a.concepts ?? 0));
  const total = sorted.reduce((s, a) => s + (a.concepts ?? 0), 0) || 1;
  const big: KbArea[] = [];
  const small: KbArea[] = [];
  sorted.forEach((a, i) => ((i < 9 && (a.concepts ?? 0) / total >= 0.04) ? big : small).push(a));
  if (small.length === 1) big.push(small.pop()!);
  if (big.length === 0 && small.length > 0) return { big: small, small: [] };
  return { big, small };
}

function areaTile(a: KbArea): Tile {
  const concepts = a.concepts ?? 0;
  return { key: a.id, weight: Math.max(concepts, MIN_WEIGHT), name: a.name, concepts, materials: a.materials, unseen: a.new_findings, pinned: a.pinned, area: a };
}

function useBox(): [MutableRefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setBox((old) => (old.w === el.clientWidth && old.h === el.clientHeight ? old : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, box];
}

export interface MapPageProps {
  clients: ExploreClients;
  hidden: boolean;
  level: string | null;
  selected: string | null;
  multi: string[];
  searches: KbSearch[];
  /** A change elsewhere (a topic renamed or merged, materials sorted): reread the level. */
  reloadKey: number;
  onLevel: (level: string | null, selected?: string | null) => void;
  onToggleMulti: (id: string) => void;
  onClearMulti: () => void;
  onOpenSearch: (id: string) => void;
  onOpenDocument: (target: DocTarget) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onTopicAction: (action: 'rename' | 'merge' | 'pin', area: KbArea) => void;
  onCovered: (covered: boolean) => void;
  /** The map of the shown level, once read (the top bar names the scope from it). */
  onMap: (map: KbAreaMap) => void;
}

export function MapPage(props: MapPageProps) {
  const { clients, level, hidden } = props;
  const [map, setMap] = useState<KbAreaMap | null>(null);
  const [materials, setMaterials] = useState<KbAreaMaterial[] | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [sorting, setSorting] = useState(false);
  const onMap = props.onMap;

  const load = useCallback(async () => {
    try {
      const next = await clients.areas.map(level ? { parent_id: level } : {});
      // A topic without subtopics opens into its materials (UX-15), sized by the concepts each gave the wiki.
      const leaf = level !== null && next.areas.length === 0;
      const mats = leaf ? (await clients.areas.materials(level, { limit: 100 })).materials : null;
      setMap(next); setMaterials(mats); setIssue(null); onMap(next);
    } catch (error) {
      setIssue(exploreIssue(error).message);
    }
  }, [clients, level, onMap]);

  useEffect(() => { if (!hidden) void load(); }, [load, hidden, props.reloadKey]);
  useEffect(() => { setOther(false); }, [level]);

  // Labelling runs in the background: follow it until it settles.
  useEffect(() => {
    if (hidden || !map || !['running', 'paused'].includes(map.labelling.state)) return undefined;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [hidden, map?.labelling.state, load]);

  const here = map && level ? map.breadcrumbs[map.breadcrumbs.length - 1] ?? null : null;
  const parent = map && map.breadcrumbs.length >= 2 ? map.breadcrumbs[map.breadcrumbs.length - 2]! : null;
  const leaf = materials !== null;
  const { big, small } = splitLevel(map?.areas ?? []);
  const shownAreas = other ? small : big;
  const tiles: Tile[] = shownAreas.map(areaTile);
  if (!other && small.length > 0) {
    const concepts = small.reduce((s, a) => s + (a.concepts ?? 0), 0);
    tiles.push({ key: '__other', weight: Math.max(concepts, MIN_WEIGHT), name: `Other · ${small.length} topics`, concepts,
      materials: small.reduce((s, a) => s + a.materials, 0), unseen: small.reduce((s, a) => s + a.new_findings, 0), pinned: false, area: null });
  }
  tiles.sort((a, b) => b.weight - a.weight);
  const selectedArea = map?.areas.find((a) => a.id === props.selected) ?? (props.selected && here?.id === props.selected ? here : null);

  const clickTile = (event: MouseEvent, tile: Tile) => {
    if (!tile.area) { setOther(true); return; }
    if (event.metaKey || event.ctrlKey) { props.onToggleMulti(tile.area.id); return; }
    void clients.areas.opened(tile.area.id).catch(() => undefined);
    // UX-15: every click goes one level deeper.
    props.onLevel(tile.area.id);
  };

  const up = () => {
    if (other) { setOther(false); return; }
    props.onLevel(parent?.id ?? null, parent?.id ?? null);
  };

  const sortTopics = async () => {
    if (!clients.topics || sorting) return;
    setSorting(true);
    try { await clients.topics.sort(); await load(); } catch (error) { setIssue(exploreIssue(error).message); } finally { setSorting(false); }
  };

  let head;
  if (other) head = <><Button size="sm" variant="quiet" icon="chevronLeft" onClick={up}>Back</Button><strong>Other topics</strong></>;
  else if (level && here) head = <>
    <Button size="sm" variant="quiet" icon="chevronLeft" onClick={up}>{parent?.name ?? 'All topics'}</Button>
    <strong>{here.name}</strong>
    {leaf && <span className="kb-ex-muted">its materials · size = concepts each gave your wiki</span>}
  </>;
  else head = <><strong>Your wiki by topic</strong><span className="kb-ex-muted">tile size = concepts in your wiki</span></>;

  return (
    <div className="kb-ex-map">
      <div className="kb-ex-map__main">
        <div className="kb-ex-map__head">{head}</div>
        {issue && <div className="kb-ex-stop" role="alert"><span>{issue}</span><Button size="sm" onClick={() => void load()}>Try again</Button></div>}
        <div className="kb-ex-treemap" aria-busy={map === null}>
          <Treemap tiles={leaf ? [] : tiles} materials={leaf ? materials : null} picked={props.multi.length > 1 ? props.multi : props.selected ? [props.selected] : []}
            onTile={clickTile} onMaterial={(id) => props.onOpenDocument({ type: 'material', id })} />
          {map && !leaf && tiles.length === 0 && <div className="kb-ex-empty"><strong>No topics yet</strong><span className="kb-ex-muted">Add materials: SKAZ sorts them into topics as your wiki grows.</span></div>}
          {leaf && materials.length === 0 && <div className="kb-ex-empty">No materials in this topic yet.</div>}
        </div>
        {map && <TopicLabelling job={map.labelling} unsorted={map.unsorted_materials} busy={sorting}
          onSort={() => void sortTopics()} onSettings={props.onOpenSettings} />}
      </div>
      <Detail {...props} map={map} area={props.multi.length > 1 ? null : selectedArea ?? here} />
    </div>
  );
}

function Treemap({ tiles, materials, picked, onTile, onMaterial }: {
  tiles: Tile[]; materials: KbAreaMaterial[] | null; picked: string[];
  onTile: (event: MouseEvent, tile: Tile) => void; onMaterial: (id: string) => void;
}) {
  const [ref, box] = useBox();
  const items = materials
    ? materials.map((m) => ({ key: m.material_id, weight: Math.max(m.concepts ?? 0, 4), name: m.title, concepts: m.concepts ?? 0 }))
      .sort((a, b) => b.weight - a.weight)
    : tiles;
  const rects = box.w > 0 && box.h > 0 ? squarify(items, 0, 0, box.w, box.h) : [];
  return (
    <div ref={ref} className="kb-ex-treemap__canvas">
      {rects.map((r) => {
        const style = { left: r.x + 2, top: r.y + 2, width: Math.max(r.w - 4, 0), height: Math.max(r.h - 4, 0) };
        const tiny = r.w < 130 || r.h < 56;
        if (materials) {
          return <button key={r.key} type="button" className={`kb-ex-tile is-material${tiny ? ' is-tiny' : ''}`} style={style}
            title={r.name} onClick={() => onMaterial(r.key)}>
            <span className="kb-ex-tile__name">{r.name}</span>
            <span className="kb-ex-tile__count">{(r as { concepts: number }).concepts} concepts</span>
          </button>;
        }
        const t = r as unknown as Tile & { x: number; y: number; w: number; h: number };
        const on = picked.includes(t.key);
        return <button key={t.key} type="button" className={`kb-ex-tile${on ? ' is-picked' : ''}${tiny ? ' is-tiny' : ''}`} style={style}
          aria-pressed={on} title={`${t.name} — ${t.concepts} concepts`} onClick={(e) => onTile(e, t)}>
          <span className="kb-ex-tile__name">{t.name}</span>
          <span className="kb-ex-tile__count">{t.concepts} concepts · {t.materials} materials{t.pinned ? ' · Pinned' : ''}</span>
          {t.unseen > 0 && <span className="kb-ex-tile__new" title={`${t.unseen} new papers`}>+{t.unseen}</span>}
        </button>;
      })}
    </div>
  );
}

function Detail(props: MapPageProps & { map: KbAreaMap | null; area: KbArea | null }) {
  const { area, map, multi } = props;
  const more = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenuState] = useState(false);
  const setMenu = (open: boolean) => { setMenuState(open); props.onCovered(open); };
  if (multi.length > 1) {
    const names = multi.map((id) => map?.areas.find((a) => a.id === id)?.name ?? id);
    return <aside className="kb-ex-detail" aria-label="Picked topics">
      <h3>{multi.length} topics picked</h3>
      <p className="kb-ex-muted">{names.join(', ')}</p>
      <p className="kb-ex-muted kb-ex-small">“Find in {multi.length} topics” above starts one search per topic, side by side.</p>
      <Button size="sm" variant="quiet" onClick={props.onClearMulti}>Clear picks</Button>
    </aside>;
  }
  const searches = props.searches.filter((s) => (area ? s.area_id === area.id : true)).slice(0, 8);
  return <aside className="kb-ex-detail" aria-label="Topic">
    <div className="kb-ex-detail__head">
      <h3>{area?.name ?? 'All your topics'}</h3>
      {area && <>
        <IconButton ref={more} icon="more" label="Topic actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} />
        <Menu open={menu} onClose={() => setMenu(false)} anchorRef={more} label="Topic actions" items={[
          { id: 'rename', label: 'Rename…', icon: 'pencil', onSelect: () => { setMenu(false); props.onTopicAction('rename', area); } },
          { id: 'merge', label: 'Merge into…', onSelect: () => { setMenu(false); props.onTopicAction('merge', area); } },
          { id: 'pin', label: area.pinned ? 'Unpin' : 'Pin', icon: area.pinned ? 'unpin' : 'pin', note: 'Weekly search', onSelect: () => { setMenu(false); props.onTopicAction('pin', area); } },
        ]} />
      </>}
    </div>
    <p className="kb-ex-muted">
      {area ? `${area.concepts ?? 0} concepts · ${area.materials} materials` : `${map?.total_pages ?? 0} wiki pages · ${map?.total_sources ?? 0} materials`}
      {area?.pinned ? ' · Pinned, searched weekly' : ''}
    </p>
    {area && <>
      <h4 className="kb-ex-detail__sub">Main concepts</h4>
      <div className="kb-ex-chips">
        {(area.top_concepts ?? []).length > 0 ? area.top_concepts!.map((c) => <span key={c} className="kb-ex-chip">{c}</span>) : <span className="kb-ex-muted">—</span>}
      </div>
    </>}
    <h4 className="kb-ex-detail__sub">Searches{area ? ' here' : ''}</h4>
    {searches.length > 0 ? <ul className="kb-ex-detail__searches">
      {searches.map((s) => <li key={s.id}>
        <button type="button" onClick={() => props.onOpenSearch(s.id)}>
          <span>{s.owner === 'weekly' ? 'Weekly · ' : ''}{s.name}</span><span className="kb-ex-muted">{searchStatus(s).text}</span>
        </button>
      </li>)}
    </ul> : <p className="kb-ex-muted">None yet</p>}
    <p className="kb-ex-muted kb-ex-small"><Icon name="search" size={12} /> “Find what&apos;s new” above searches {area ? 'this topic' : 'all your topics'}. ⌘-click tiles to search several at once.</p>
  </aside>;
}
