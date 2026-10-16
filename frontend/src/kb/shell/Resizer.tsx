import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

export interface ResizerProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** +1: dragging right grows the column (left panel); -1: dragging left grows it (right panel). */
  direction: 1 | -1;
  onChange: (px: number) => void;
  controls: string;
}

const STEP = 16;

/** Column edge you can drag; also a keyboard separator (arrows, Home/End) — a drag is never the only way. */
export function Resizer({ label, value, min, max, direction, onChange, controls }: ResizerProps) {
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = { x: event.clientX, width: value };
    document.body.classList.add('kb-resizing');
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const next = start.current.width + direction * (event.clientX - start.current.x);
    onChange(Math.min(max, Math.max(min, Math.round(next))));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    document.body.classList.remove('kb-resizing');
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = direction === 1 ? 'ArrowRight' : 'ArrowLeft';
    const shrink = direction === 1 ? 'ArrowLeft' : 'ArrowRight';
    let next: number | null = null;
    if (event.key === grow) next = value + STEP;
    else if (event.key === shrink) next = value - STEP;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    onChange(Math.min(max, Math.max(min, next)));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className="kb-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
