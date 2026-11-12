import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { KbArea } from '../../api/kb/types.gen';
import { Icon } from '../ui';
import { useReducedMotion } from '../ui/motionLevel';
import { formatWikiShare, layoutAreaTiles } from './treemap';

export interface ExploreMapProps {
  areas: readonly KbArea[];
  /** Kept for callers of the original map; weights come exclusively from each topic's materials. */
  parentPages: number;
  selectedAreaId: string | null;
  scanning: boolean;
  activeAreaIds: readonly string[];
  justDone: boolean;
  scopeKey?: string | null;
  onSelectArea: (area: KbArea) => void;
}

export function ExploreMap({ areas, parentPages, selectedAreaId, scanning, activeAreaIds, justDone, scopeKey, onSelectArea }: ExploreMapProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 640, h: 420 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const otherRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth; const h = el.clientHeight;
      if (w > 0 && h > 0) setSize((old) => old.w === w && old.h === h ? old : { w, h });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setOtherOpen(false); setHoveredId(null); }, [scopeKey]);
  useEffect(() => { if (otherOpen) backRef.current?.focus(); }, [otherOpen]);
  const tiles = useMemo(() => layoutAreaTiles(areas, parentPages, size.w, size.h), [areas, parentPages, size]);
  const other = tiles.find((tile) => tile.area === null);
  const hovered = tiles.find((tile) => (tile.area?.id ?? 'other') === hoveredId);
  const closeOther = () => { setOtherOpen(false); window.requestAnimationFrame(() => otherRef.current?.focus()); };

  return (
    <div className="kb-explore-map" aria-label="Your topic map">
      <div ref={slotRef} className={`kb-explore-map__slot${scanning ? reducedMotion ? ' is-scanning-static' : ' is-scanning' : ''}`}
        style={{ '--mw': `${size.w}px`, '--mh': `${size.h}px` } as CSSProperties}
        onMouseLeave={() => setHoveredId(null)}>
        {otherOpen && other ? (
          <div className="kb-explore-other">
            <button ref={backRef} type="button" className="kb-explore-back" onClick={closeOther}>
              <Icon name="chevronLeft" size={14} />Back to topics
            </button>
            <h2 className="kb-explore-section-title">Other</h2>
            <div className="kb-explore-topic-list" aria-label="Small topics">
              {other.members.map((area) => <button key={area.id} type="button" className="kb-explore-item"
                onClick={() => onSelectArea(area)}>{area.name}</button>)}
            </div>
          </div>
        ) : tiles.length === 0 ? (
          <p className="kb-explore-cap">Your topics appear here after wiki materials are organized.</p>
        ) : tiles.map((tile, index) => {
          const { area, x, y, w, h, small } = tile;
          const id = area?.id ?? 'other'; const name = area?.name ?? 'Other';
          const selected = selectedAreaId !== null && tile.members.some((member) => member.id === selectedAreaId);
          const scanned = scanning && (activeAreaIds.length === 0 || tile.members.some((member) => activeAreaIds.includes(member.id)));
          const newFindings = tile.members.reduce((sum, member) => sum + member.new_findings, 0);
          return <button key={id} ref={area ? undefined : otherRef} type="button" data-area-id={id}
            className={`kb-explore-tile kb-explore-tile--${area?.depth ?? 'thin'}${small ? ' kb-explore-tile--small' : ''}${selected ? ' is-selected' : ''}${hoveredId === id ? ' is-hovered' : ''}${scanned ? ' is-scan' : ''}`}
            style={{ left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, '--tx': `${x}px`, '--ty': `${y}px`, '--d': `${index * 0.12}s` } as CSSProperties}
            aria-label={`${name} · ${formatWikiShare(tile.share)} of your wiki`} aria-pressed={selected || undefined}
            onClick={() => { if (area) onSelectArea(area); else { setHoveredId(null); setOtherOpen(true); } }}
            onMouseEnter={() => setHoveredId(id)} onFocus={() => setHoveredId(id)} onBlur={() => setHoveredId(null)}>
            <span className="kb-explore-tile__name"><span className="kb-explore-tile__title">{name}</span></span>
            {w > 54 && h > 52 && <span className="kb-explore-tile__pct">{formatWikiShare(tile.share)}</span>}
            {!scanning && newFindings > 0 && w > 84 && h > 48 && <span className={`kb-explore-tile__new${justDone && !reducedMotion ? ' is-pop' : ''}`}>+{newFindings} new</span>}
            {w > 110 && h > 48 && <span className="kb-explore-tile__hint" aria-hidden="true">{!area || area.has_children ? <>Open<Icon name="chevronRight" size={14} /></> : 'Materials'}</span>}
          </button>;
        })}
        {!otherOpen && hovered && <div role="tooltip" className="kb-explore-map__tooltip"
          style={{ left: `${Math.max(8, Math.min(hovered.x + 16, size.w - 236))}px`, top: `${Math.max(8, Math.min(hovered.y + 40, size.h - 110))}px` }}>
          <strong className="kb-explore-map__tooltip-title">{hovered.area?.name ?? 'Other'}</strong>
          <div className="kb-explore-map__tooltip-meta">
            <div>{formatWikiShare(hovered.share)} of your wiki · {hovered.weight} {hovered.weight === 1 ? 'material' : 'materials'}</div>
            {hovered.area ? <>
              <div>{hovered.area.pages} concept pages · {hovered.area.sources} sources</div>
              <div>You marked {hovered.area.marked_materials} · {hovered.area.new_findings > 0 ? `${hovered.area.new_findings} new` : 'nothing new'}</div>
            </> : <div>{hovered.members.length} small topics · open to choose one</div>}
          </div>
        </div>}
      </div>
    </div>
  );
}
