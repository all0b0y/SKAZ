/**
 * The SKAZ startup screen (variant A «Соки снизу», mockup `loading-tree-v41.html`): the tree
 * mark alone, centred in the window, its roots ending inside it.
 *
 *   - starting: sap waves rise from the root tips to the trunk (3.6 s loop, each folder colour
 *     offset), the grove crowns flare as a wave reaches them; the crown and trunk stay still;
 *   - error: the roots turn amber, the deepest pixels fall away and the tree lifts and shrinks
 *     above the message (the caller's banner with its buttons);
 *   - ready: the screen fades out over the app (the caller unmounts it afterwards);
 *   - reduced motion: nothing moves, the roots pulse slowly in opacity; no fall on error.
 *
 * Everything is CSS animation (no JS frame loop), paused while the window is hidden. Geometry
 * comes from the icon's own modules, colours from the theme tokens.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CROWN_CIRCLES, ROOT_CELLS, TRUNK_PATH } from './treeGeometry.ts';
import { GROVE_CROWNS, rootColour, type FolderColour } from './appIcon.ts';
import './LoadingTree.css';

export type LoadingTreePhase = 'starting' | 'error' | 'ready';

/** One loop of the sap wave, seconds. */
export const SAP_LOOP_S = 3.6;
/** Where each folder colour's wave starts within the loop. */
const COLOUR_OFFSET_S: Readonly<Record<FolderColour, number>> = { blue: 0, purple: 1.2, olive: 2.4 };
/** Time the wave takes from the deepest tip to the ground. */
const RISE_S = 1.15;
/** Pixels at least this deep fall away on error. */
export const FALL_DEPTH = 0.66;

export interface RootPixel {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly colour: FolderColour;
  readonly opacity: number;
  /** Delay of this pixel's flare in the sap loop: bottom first, then up; per-colour offset. */
  readonly sapDelay: number;
  readonly deep: boolean;
  /** Delay of the fall on error (deep pixels only). */
  readonly fallDelay: number;
}

const ys = ROOT_CELLS.map((cell) => cell.y);
const yMin = Math.min(...ys);
const yMax = Math.max(...ys);

export const ROOT_PIXELS: readonly RootPixel[] = ROOT_CELLS.map((cell, index) => {
  const colour = rootColour(index);
  const fromBottom = (yMax - cell.y) / (yMax - yMin || 1);
  return {
    x: cell.x,
    y: cell.y,
    size: cell.size,
    colour,
    opacity: cell.opacity,
    sapDelay: round(COLOUR_OFFSET_S[colour] + fromBottom * RISE_S),
    deep: cell.depth >= FALL_DEPTH,
    // Golden-ratio scatter: deterministic, evenly spread over 0–0.5 s.
    fallDelay: round(((index * 0.618034) % 1) * 0.5),
  };
});

/** Bounding box of the mark (crown, grove, roots), so the view box can centre it exactly. */
function markBounds() {
  const circles = [...CROWN_CIRCLES, ...GROVE_CROWNS.flatMap((crown) => crown.circles)];
  const left = Math.min(...circles.map(([cx, , r]) => cx - r), ...ROOT_CELLS.map((c) => c.x));
  const right = Math.max(...circles.map(([cx, , r]) => cx + r), ...ROOT_CELLS.map((c) => c.x + c.size));
  const top = Math.min(...circles.map(([, cy, r]) => cy - r));
  const bottom = Math.max(...ROOT_CELLS.map((c) => c.y + c.size));
  return { left, right, top, bottom };
}

/** The mockup's frame around the mark (1384 × 1240 units): the roots end well inside the window. */
const VIEW_W = 1384;
const VIEW_H = 1240;
const bounds = markBounds();
export const VIEW_BOX = [
  round((bounds.left + bounds.right) / 2 - VIEW_W / 2),
  round((bounds.top + bounds.bottom) / 2 - VIEW_H / 2),
  VIEW_W,
  VIEW_H,
].join(' ');

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return undefined;
    const onChange = () => setReduced(media.matches);
    onChange();
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
}

function TreeMark() {
  return (
    <>
      <g className="skaz-loading__roots">
        {ROOT_PIXELS.map((pixel, index) => (
          <rect
            key={index}
            x={pixel.x}
            y={pixel.y}
            width={pixel.size}
            height={pixel.size}
            rx={2}
            className={`skaz-loading__px skaz-loading__px--${pixel.colour}${pixel.deep ? ' skaz-loading__px--deep' : ''}`}
            style={{ '--o': pixel.opacity, '--sap': `${pixel.sapDelay}s`, '--fall': `${pixel.fallDelay}s` } as CSSProperties}
          />
        ))}
      </g>
      {GROVE_CROWNS.map((crown) => (
        <g key={crown.colour} className={`skaz-loading__grove skaz-loading__grove--${crown.colour}`}>
          {crown.circles.map(([cx, cy, r], index) => <circle key={index} cx={cx} cy={cy} r={r} />)}
        </g>
      ))}
      <g className="skaz-loading__tree">
        {CROWN_CIRCLES.map(([cx, cy, r], index) => <circle key={index} cx={cx} cy={cy} r={r} />)}
        <path d={TRUNK_PATH} />
      </g>
    </>
  );
}

interface LoadingTreeProps {
  phase: LoadingTreePhase;
  /** Changes on every new start (Try again): the animation begins from its first frame. */
  attempt?: number;
  /** Shown under the tree on error: what went wrong and what to do. */
  children?: ReactNode;
}

export function LoadingTree({ phase, attempt = 0, children }: LoadingTreeProps) {
  const reduced = usePrefersReducedMotion();
  const hidden = useDocumentHidden();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const message = phase === 'error' ? children : null;

  // The message takes the bottom of the window and the stage shrinks above it at once; the tree
  // is then animated from where it stood to where it now stands (FLIP), so it lifts and scales
  // instead of jumping and never overlaps the message.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (phase !== 'error') {
      root.style.removeProperty('--lift-y');
      root.style.removeProperty('--lift-s');
      return;
    }
    const total = root.clientHeight;
    const width = root.clientWidth;
    const stage = stageRef.current?.clientHeight ?? 0;
    if (!total || !width || !stage) return;
    const stageTop = stageRef.current?.offsetTop ?? 0;
    // Before: centred in the whole window; after: centred in the stage above the message.
    const fit = (height: number) => Math.min(width / VIEW_W, height / VIEW_H);
    root.style.setProperty('--lift-y', `${round(total / 2 - (stageTop + stage / 2))}px`);
    root.style.setProperty('--lift-s', String(round(fit(total) / fit(stage))));
  }, [phase, attempt]);

  return (
    <div
      ref={rootRef}
      className="skaz-loading"
      data-testid="loading-tree"
      data-phase={phase}
      data-motion={reduced ? 'reduced' : 'full'}
      data-paused={hidden ? 'true' : undefined}
      aria-hidden={phase === 'ready' ? true : undefined}
    >
      <div ref={stageRef} className="skaz-loading__stage">
        <svg key={attempt} className="skaz-loading__mark" viewBox={VIEW_BOX} preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
          <TreeMark />
        </svg>
      </div>
      {message ? <div className="skaz-loading__message">{message}</div> : null}
      <div role="status" className="skaz-loading__sr">{phase === 'starting' ? 'Starting SKAZ…' : ''}</div>
    </div>
  );
}
