import { useEffect, useRef, useState } from 'react';
import { useStillIndicators } from '../../ui/motionLevel';
import { FxCanvas } from '../FxCanvas';
import { mixRgb, rgba } from '../colors';
import { globeDots, ringDots } from './work';

/** One shared runtime. Completion is a short observed transition, never a replay of loaded history. */
function StippleWork({ shape, className = '', complete = false }: {
  shape: 'globe' | 'ring'; className?: string; complete?: boolean;
}) {
  const reduced = useStillIndicators();
  const wasRunning = useRef(!complete);
  const completedAt = useRef<number | null>(null);
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    if (!complete) {
      wasRunning.current = true;
      completedAt.current = null;
      setGlow(false);
      return undefined;
    }
    const observed = wasRunning.current;
    wasRunning.current = false;
    if (!observed || reduced) { setGlow(false); return undefined; }
    completedAt.current = performance.now();
    setGlow(true);
    const timer = window.setTimeout(() => setGlow(false), 1000);
    return () => window.clearTimeout(timer);
  }, [complete, reduced]);
  return (
    <span className={`kb-stipwork kb-stipwork--${shape} ${className}`} aria-hidden="true"
      data-completion={complete ? (glow ? 'glow' : 'still') : undefined}
      data-stipple-globe={shape === 'globe' ? '' : undefined} data-stipple-ring={shape === 'ring' ? '' : undefined}>
      <FxCanvas className="kb-stipwork__canvas" dpr={1} active={!complete || glow}
        reduced={reduced || (complete && !glow)} redrawKey={`${complete}:${glow}`} stillT={1.5}
        onFrame={(ctx, w, h, t, _dt, colors) => {
          const age = complete
            ? (glow && completedAt.current !== null ? (performance.now() - completedAt.current) / 1000 : 1)
            : undefined;
          const dots = shape === 'globe' ? globeDots(w, h, t, age) : ringDots(w, h, t);
          for (const d of dots) {
            ctx.fillStyle = rgba(mixRgb(colors.ink, colors.accent, d.k), d.alpha);
            ctx.beginPath();
            ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
            ctx.fill();
          }
        }} />
    </span>
  );
}

/** Decorative; only the containing search card knows whether execution actually completed. */
export function StippleGlobe({ className, complete }: { className?: string; complete?: boolean }) {
  return <StippleWork shape="globe" className={className} complete={complete} />;
}

/** Mount only for a real in-flight operation. The parent's status words remain accessible. */
export function StippleRing({ className }: { className?: string }) {
  return <StippleWork shape="ring" className={className} />;
}
