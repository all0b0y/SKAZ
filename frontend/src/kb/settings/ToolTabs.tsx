import { useEffect, useRef } from 'react';
import { useMotionLevel } from '../ui/motionLevel';

export type ToolKind = 'mcp' | 'skill';

export function ToolTabs({ kind, select, counts, prefix }: {
  kind: ToolKind; select: (kind: ToolKind) => void; counts: [number, number]; prefix: string;
}) {
  const sheet = useRef<HTMLSpanElement>(null);
  const level = useMotionLevel();
  useEffect(() => {
    const pill = sheet.current;
    const stop = () => pill?.getAnimations?.().forEach(animation => animation.cancel());
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    stop();
    reduced?.addEventListener('change', stop);
    window.addEventListener('resize', stop);
    return () => { stop(); reduced?.removeEventListener('change', stop); window.removeEventListener('resize', stop); };
  }, [level]);

  function move(to: ToolKind) {
    if (kind === to) return;
    const pill = sheet.current;
    if (pill?.animate && level === 'full' && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      const pose = new DOMMatrixReadOnly(getComputedStyle(pill).transform);
      pill.getAnimations().forEach(animation => animation.cancel());
      pill.dataset.side = to;
      const travel = new DOMMatrixReadOnly(getComputedStyle(pill).transform).e - pose.e;
      const strength = Math.min(1, Math.abs(travel) / Math.max(1, pill.offsetWidth));
      const frame = (offset: number, progress: number, x: number, y: number, easing: string) => ({
        offset, easing, transform: 'translateX(' + (pose.e + travel * progress) + 'px) scale(' + x + ', ' + y + ')',
      });
      if (strength > .005) pill.animate([
        frame(0, 0, pose.a, pose.d, 'cubic-bezier(.45,0,.72,.55)'),
        frame(.34, .36, 1 + .14 * strength, 1 - .09 * strength, 'cubic-bezier(.24,.51,.32,1)'),
        frame(.72, 1, 1 - .045 * strength, 1 + .055 * strength, 'cubic-bezier(.2,.7,.35,1)'),
        frame(1, 1, 1, 1, 'linear'),
      ], { duration: 160 + 120 * strength });
    }
    select(to);
  }
  return <div className="kb-tool-tabs" role="tablist" aria-label="Tool type">
    <span ref={sheet} className="kb-tool-pill" aria-hidden="true" data-side={kind} />
    {(['mcp', 'skill'] as const).map((key, index) => <button type="button" key={key} role="tab"
      id={prefix + key} aria-selected={kind === key} tabIndex={kind === key ? 0 : -1} aria-controls={prefix + 'panel'}
      onClick={() => move(key)} onKeyDown={event => {
        if (!['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'mcp' : event.key === 'End' ? 'skill' : key === 'mcp' ? 'skill' : 'mcp';
        move(next);
        document.getElementById(prefix + next)?.focus();
      }}>{key === 'mcp' ? 'MCP' : 'Skills'} <span>{counts[index]}</span></button>)}
  </div>;
}
