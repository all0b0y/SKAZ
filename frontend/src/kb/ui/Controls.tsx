import { useId, type ReactNode } from 'react';
import { m } from 'motion/react';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name (visible label lives in the settings row; pass the same text). */
  label: string;
  disabled?: boolean;
  describedBy?: string;
}

/** On/off toggle. A native button with role="switch": Space and Enter toggle, Tab reaches it. */
export function Switch({ checked, onChange, label, disabled = false, describedBy }: SwitchProps) {
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
      <span className="kb-switch__knob" aria-hidden="true" />
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
  const group = useId();
  const enabled = options.filter((o) => !o.disabled && !disabled);
  const move = (dir: 1 | -1, from: T) => {
    if (enabled.length === 0) return;
    const i = enabled.findIndex((o) => o.value === from);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    requestAnimationFrame(() => document.getElementById(`${group}-${next.value}`)?.focus());
  };
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={`kb-seg kb-seg--${size}`}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            id={`${group}-${o.value}`}
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
            {selected && <m.span layoutId={`${group}-indicator`} className="kb-seg__ind" aria-hidden="true" />}
            <span className="kb-seg__text">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
