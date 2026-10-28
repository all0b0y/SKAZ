import { useCallback, useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { FxCanvas } from '../FxCanvas';
import { FX_FRAME_MS, FX_REST_MS } from '../loop';
import { DitherScene, MAIN_SCENE } from './scene';

/** The reduced-motion still frame of the field (the mock's fixed time). */
export const FIELD_STILL_T = 4;

const displayFamily = (el: Element) => getComputedStyle(el).getPropertyValue('--kb-font-display').trim() || 'sans-serif';

export interface DitherStageProps {
  /** The field is there (an empty chat); false = a plain wrapper around the children. */
  show: boolean;
  /** The first message was sent: the field burns out (§6) and takes no more clicks. */
  leaving: boolean;
  /** The view is on screen (the loop stops while its section is hidden). */
  active: boolean;
  /** One still frame, no clicks: motion «off» or the system's reduced motion. */
  reduced: boolean;
  /**
   * Motion «calm» (decision 32): the field still answers clicks (links grow and fade), only the slow
   * background drift stands still — and with nothing live the loop idles at 1 fps.
   */
  calm?: boolean;
  className?: string;
  children: ReactNode;
}

/** At «calm» with no live links nothing moves: one frame a second is plenty. */
const CALM_REST_MS = 1000;

/**
 * The 1-bit dither «Connect on click» field behind the children (FX-EFFECTS-SPEC Batch A §2–4, 6).
 * The wrapper is always rendered so the children (the conversation) never remount when the field
 * comes or goes; only the canvas does. Clicks anywhere on the wrapper grow links from that point.
 * At rest only the slow drift moves, so the field redraws at ≤ 4 fps; it runs at ~30 fps while links
 * live or while it burns out (review Q3). Its canvas stops by itself when off-screen (FxCanvas).
 */
export function DitherStage({ show, leaving, active, reduced, calm = false, className, children }: DitherStageProps) {
  const sceneRef = useRef<DitherScene | null>(null);
  // A new empty view starts a fresh field: no links left over from the last one.
  if (show && !sceneRef.current) sceneRef.current = new DitherScene(MAIN_SCENE);
  if (!show) sceneRef.current = null;
  const familyRef = useRef<string | null>(null);
  const [fontTick, setFontTick] = useState(0);
  const interactive = show && active && !leaving && !reduced;
  const drifts = !reduced && !calm;
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;
  const driftsRef = useRef(drifts);
  driftsRef.current = drifts;
  const frameMs = useCallback(() => (leavingRef.current || sceneRef.current?.busy ? FX_FRAME_MS
    : driftsRef.current ? FX_REST_MS : CALM_REST_MS), []);

  // Hidden (another section, the chat list): the links go, so none of them reappears when shown.
  useEffect(() => { if (!active) sceneRef.current?.reset(); }, [active]);

  // The wordmark must be measured in the display face: when it arrives, measure again.
  useEffect(() => {
    if (!show || typeof document === 'undefined' || !document.fonts?.load) return undefined;
    let alive = true;
    const family = displayFamily(document.documentElement);
    document.fonts.load(`700 100px ${family}`).then(() => {
      if (!alive) return;
      sceneRef.current?.invalidate();
      setFontTick((n) => n + 1);
    }, () => undefined);
    return () => { alive = false; };
  }, [show]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const r = e.currentTarget.getBoundingClientRect();
    sceneRef.current?.click(e.clientX - r.left, e.clientY - r.top);
  };

  return (
    <div className={className} data-fx={show ? (leaving ? 'leaving' : 'field') : undefined}
      data-still={show && reduced ? 'true' : undefined} data-interactive={interactive ? 'true' : undefined}
      data-drift={show && !reduced && calm ? 'still' : undefined}
      onPointerDown={show ? onPointerDown : undefined}>
      {show && (
        <FxCanvas className="kb-fx-field" active={active} reduced={reduced} stillT={FIELD_STILL_T} redrawKey={fontTick} frameMs={frameMs}
          onFrame={(ctx, w, h, t, _dt, colors) => {
            familyRef.current ??= displayFamily(ctx.canvas);
            sceneRef.current?.draw(ctx, w, h, t, colors, familyRef.current, leaving && !reduced, drifts ? t : FIELD_STILL_T);
          }} />
      )}
      {children}
    </div>
  );
}
