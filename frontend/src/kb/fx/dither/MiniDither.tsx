import { useReducedMotion } from 'motion/react';
import { useRef, useState, type PointerEvent } from 'react';
import { FxCanvas } from '../FxCanvas';
import { MiniScene } from './mini';

export interface MiniDitherProps {
  /** Normal empty state 70 css px tall, compact 40. */
  compact?: boolean;
  /** One still frame, no reaction to clicks. Default: the system's reduced-motion setting. */
  reduced?: boolean;
  className?: string;
}

/**
 * The small «Dither · Connect» field above an empty state's icon and title (FX-EFFECTS-SPEC B3).
 * Decorative (aria-hidden, never behind text). Static at rest — the animation loop runs only while
 * a click's links are alive, then stops on a clean frame.
 */
export function MiniDither({ compact = false, reduced: forced, className }: MiniDitherProps) {
  const system = useReducedMotion();
  const reduced = forced ?? system ?? false;
  const sceneRef = useRef<MiniScene | null>(null);
  sceneRef.current ??= new MiniScene();
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);
  const set = (v: boolean) => { if (liveRef.current !== v) { liveRef.current = v; setLive(v); } };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    sceneRef.current!.click(e.clientX - r.left, e.clientY - r.top);
    set(true);
  };

  const cls = `kb-empty__field${compact ? ' kb-empty__field--compact' : ''}${className ? ` ${className}` : ''}`;
  return (
    <div className={cls} data-fx="mini" data-still={reduced ? 'true' : undefined} data-interactive={reduced ? undefined : 'true'}
      onPointerDown={reduced ? undefined : onPointerDown}>
      <FxCanvas className="kb-fx-mini" active={live && !reduced} reduced={reduced}
        onFrame={(ctx, w, h, t, _dt, colors) => { if (!sceneRef.current!.draw(ctx, w, h, t, colors)) set(false); }} />
    </div>
  );
}
