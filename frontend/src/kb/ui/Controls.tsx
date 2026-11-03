import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { springEasing } from './ActiveTab';
import { useMotionLevel } from './motionLevel';

/** SquishSwitch (stage 6, B10, the motion6 demo): the knob's travel at «full». */
export const SQUISH_MS = 300;
const SQUISH_EASING = 'cubic-bezier(0.3, 0.7, 0.3, 1)';
const SEG_SPRING = springEasing(0.26, 0);
/** Knob geometry of ui.css .kb-switch: 14 px round, 12 px of travel, 20 px at the stretch. */
const KNOB = 14;
const KNOB_STRETCH = 20;
const TRAVEL = 12;

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name (visible label lives in the settings row; pass the same text). */
  label: string;
  disabled?: boolean;
  describedBy?: string;
}

/**
 * On/off toggle. A native button with role="switch": Space and Enter toggle, Tab reaches it.
 * At motion «full» the knob stretches while it travels (14 → 20 → 14 px, anchored on the near edge,
 * 0.3 s); at «calm» it is the plain CSS slide, at «off» the colour changes at once.
 */
export function Switch({ checked, onChange, label, disabled = false, describedBy }: SwitchProps) {
  const level = useMotionLevel();
  const knob = useRef<HTMLSpanElement | null>(null);
  const was = useRef(checked);
  useLayoutEffect(() => {
    if (was.current === checked) return;
    was.current = checked;
    const el = knob.current;
    if (level !== 'full' || !el || typeof el.animate !== 'function') return;
    const from = checked ? 0 : TRAVEL;
    const to = checked ? TRAVEL : 0;
    el.getAnimations?.().forEach((a) => a.cancel());
    el.animate([
      { transform: `translateX(${from}px)`, width: `${KNOB}px` },
      { transform: `translateX(${Math.min(from, to)}px)`, width: `${KNOB_STRETCH}px`, offset: 0.45 },
      { transform: `translateX(${to}px)`, width: `${KNOB}px` },
    ], { duration: SQUISH_MS, easing: SQUISH_EASING });
  }, [checked, level]);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className={`kb-switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span ref={knob} className="kb-switch__knob" aria-hidden="true" />
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when `label` is not plain text. */
  name?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

/** One-of-N choice (radiogroup). Arrow keys move and select, like native radios. */
export function Segmented<T extends string>({ value, options, onChange, label, disabled = false, size = 'md' }: SegmentedProps<T>) {
  const level = useMotionLevel();
  const group = useId();
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const ind = useRef<HTMLSpanElement | null>(null);
  const was = useRef(value);
  useLayoutEffect(() => {
    const prev = was.current;
    if (prev === value) return;
    was.current = value;
    const el = ind.current;
    const fromBtn = buttons.current.get(prev);
    const toBtn = buttons.current.get(value);
    if (level !== 'full' || !el || !fromBtn || !toBtn || typeof el.animate !== 'function') return;
    const fromW = fromBtn.offsetWidth;
    const toW = toBtn.offsetWidth;
    if (!fromW || !toW) return;
    const dx = fromBtn.offsetLeft - toBtn.offsetLeft;
    const dy = fromBtn.offsetTop - toBtn.offsetTop;
    el.getAnimations?.().forEach((a) => a.cancel());
    el.animate([
      { transform: `translate(${dx}px, ${dy}px)`, width: `${fromW}px` },
      { transform: 'translate(0px, 0px)', width: `${toW}px` },
    ], { duration: SEG_SPRING.duration, easing: SEG_SPRING.easing });
  }, [value, level]);
  const enabled = options.filter((o) => !o.disabled && !disabled);
  const move = (dir: 1 | -1, from: T) => {
    if (enabled.length === 0) return;
    const i = enabled.findIndex((o) => o.value === from);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    // Focus moves now, with the choice, like native radios: the button already exists (only its
    // tabIndex changes on re-render), so a later frame would only let the next key start from the
    // old option.
    buttons.current.get(next.value)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={`kb-seg kb-seg--${size}`}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            id={`${group}-${o.value}`}
            ref={(el) => { if (el) buttons.current.set(o.value, el); else buttons.current.delete(o.value); }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.name}
            tabIndex={selected ? 0 : -1}
            disabled={disabled || o.disabled}
            className={`kb-seg__opt${selected ? ' is-on' : ''}`}
            onClick={() => onChange(o.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(1, o.value); }
              if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(-1, o.value); }
            }}
          >
            {selected && <span ref={ind} className="kb-seg__ind" aria-hidden="true" />}
            <span className="kb-seg__text">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
