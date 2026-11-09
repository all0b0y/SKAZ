import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { KbArea } from '../../api/kb/types.gen';
import { Icon } from '../ui';
import { useReducedMotion } from '../ui/motionLevel';
import { formatWikiShare, layoutAreaTiles } from './treemap';

export interface ExploreMapProps {
  areas: readonly KbArea[];
  parentPages: number;
  selectedAreaId: string | null;
  scanning: boolean;
  activeAreaIds: readonly string[];
  justDone: boolean;
  onSelectArea: (area: KbArea) => void;
}

const DEFAULT_MAP_W = 640;
const DEFAULT_MAP_H = 420;

export function ExploreMap({
  areas,
  parentPages,
  selectedAreaId,
  scanning,
  activeAreaIds,
  justDone,
  onSelectArea,
}: ExploreMapProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: DEFAULT_MAP_W, h: DEFAULT_MAP_H });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();

  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const measure = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw > 0 && ch > 0) {
        setSize((prev) => (prev.w === cw && prev.h === ch ? prev : { w: cw, h: ch }));
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setHoveredId(null);
  }, [areas]);

  const tiles = useMemo(
    () => layoutAreaTiles(areas, parentPages, size.w, size.h),
    [areas, parentPages, size.w, size.h],
  );

  const activeSet = useMemo(() => new Set(activeAreaIds), [activeAreaIds]);
  const hoveredTile = useMemo(
    () => (hoveredId ? tiles.find((t) => t.area.id === hoveredId) ?? null : null),
    [hoveredId, tiles],
  );

  const slotStyle = {
    '--mw': `${size.w}px`,
    '--mh': `${size.h}px`,
  } as CSSProperties;

  const slotClasses = [
    'kb-explore-map__slot',
    scanning && !reducedMotion ? 'is-scanning' : '',
    scanning && reducedMotion ? 'is-scanning-static' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="kb-explore-map">
      <div
        ref={slotRef}
        className={slotClasses}
        style={slotStyle}
        onMouseLeave={() => setHoveredId(null)}
      >
        {tiles.map((tile, index) => {
          const { area, x, y, w, h, isGap, small } = tile;
          const isSelected = selectedAreaId === area.id;
          const isTileScanned =
            scanning && !isGap && (activeSet.size === 0 || activeSet.has(area.id));
          const showNewBadge = !scanning && area.new_findings > 0 && w > 84 && h > 48;
          const showPct = !isGap && w > 54 && h > 52;
          const showHint = w > 110 && h > 48 && !isGap;

          const tileStyle = {
            '--tx': `${Math.round(x)}px`,
            '--ty': `${Math.round(y)}px`,
            '--d': `${(index * 0.12).toFixed(2)}s`,
            left: `${x}px`,
            top: `${y}px`,
            width: `${w}px`,
            height: `${h}px`,
          } as CSSProperties;

          const classes = [
            'kb-explore-tile',
            isGap ? 'kb-explore-tile--gap' : `kb-explore-tile--${area.depth}`,
            small ? 'kb-explore-tile--small' : '',
            isSelected ? 'is-selected' : '',
            hoveredId === area.id ? 'is-hovered' : '',
            isTileScanned ? 'is-scan' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <button
              key={area.id}
              type="button"
              className={classes}
              style={tileStyle}
              data-area-id={area.id}
              aria-pressed={isSelected || undefined}
              onClick={() => onSelectArea(area)}
              onMouseEnter={() => setHoveredId(area.id)}
              onFocus={() => setHoveredId(area.id)}
              onBlur={() => setHoveredId((prev) => (prev === area.id ? null : prev))}
            >
              <span className="kb-explore-tile__name">
                <span className="kb-explore-tile__title">{area.name}</span>
              </span>
              {showPct && (
                <span className="kb-explore-tile__pct">{formatWikiShare(area.wiki_share)}</span>
              )}
              {showNewBadge && (
                <span
                  className={`kb-explore-tile__new${justDone && !reducedMotion ? ' is-pop' : ''}`}
                >
                  +{area.new_findings} new
                </span>
              )}
              {showHint && (
                <span className="kb-explore-tile__hint" aria-hidden="true">
                  {area.has_children ? (
                    <>
                      Open
                      <Icon name="chevronRight" size={14} />
                    </>
                  ) : (
                    'Materials'
                  )}
                </span>
              )}
            </button>
          );
        })}

        {hoveredTile && (
          <div
            role="tooltip"
            className="kb-explore-map__tooltip"
            style={{
              left: `${Math.max(8, Math.min(hoveredTile.x + 16, size.w - 236))}px`,
              top: `${Math.max(8, Math.min(hoveredTile.y + 40, size.h - 110))}px`,
            }}
          >
            <strong className="kb-explore-map__tooltip-title">{hoveredTile.area.name}</strong>
            {hoveredTile.isGap ? (
              <div className="kb-explore-map__tooltip-meta">
                {hoveredTile.area.gap_reason ?? 'Next to what you study lately · no pages yet'}
              </div>
            ) : (
              <div className="kb-explore-map__tooltip-meta">
                <div>
                  {formatWikiShare(hoveredTile.area.wiki_share)} of your wiki ·{' '}
                  {hoveredTile.area.pages} pages
                </div>
                <div>
                  {hoveredTile.area.sources}{' '}
                  {hoveredTile.area.sources === 1 ? 'source' : 'sources'}
                  {hoveredTile.area.newest_source_year
                    ? `, newest ${hoveredTile.area.newest_source_year}`
                    : ''}{' '}
                  · {hoveredTile.area.depth}
                </div>
                <div>
                  You marked {hoveredTile.area.marked_materials} ·{' '}
                  {hoveredTile.area.new_findings > 0
                    ? `${hoveredTile.area.new_findings} new`
                    : 'nothing new'}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
