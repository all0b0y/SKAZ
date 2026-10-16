import { useEffect, useId, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { ChatScope } from '../../api/types';
import { Icon } from '../ui/Icon';
import { AnchoredPopover, isInside } from '../ui/AnchoredPopover';

export const SCOPES: { value: ChatScope; label: string; hint: string }[] = [
  { value: 'session', label: 'Session', hint: 'The open recording' },
  { value: 'group', label: 'Group', hint: 'Recordings in the open session’s group' },
  { value: 'all', label: 'All', hint: 'All recordings in the library, including ungrouped ones' },
];

interface ScopeMenuProps {
  scope: ChatScope;
  onChange: (scope: ChatScope) => void;
  /** Accessible name of the trigger for the shown scope. */
  label: (name: string) => string;
  /** Tooltip of the trigger. */
  title: string;
  /** One line under the heading: what choosing a scope does here. */
  note: string;
  /** The choices are visible but cannot be picked right now (an answer is running). */
  locked?: boolean;
  disabled?: boolean;
  /** Scopes that cannot be chosen now, with the reason shown under the choices. */
  unavailable?: Partial<Record<ChatScope, string>>;
  /** The menu opened: a chance to re-check what is available. */
  onOpen?: () => void;
}

/** Where the assistant looks for answers, in the header of every Assistant engine. */
export function ScopeMenu({ scope, onChange, label, title, note, locked, disabled, unavailable, onOpen }: ScopeMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const reasonId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (e.button !== 2 && !isInside(e.target, ref, popover)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const name = SCOPES.find((s) => s.value === scope)?.label ?? 'Session';
  const reasons = SCOPES.flatMap((s) => (unavailable?.[s.value] ? [unavailable[s.value]!] : []));
  return (
    <div className="codex-scope" ref={ref}>
      <button ref={trigger} type="button" className="codex-head__scope codex-head__scope--menu" aria-haspopup="true"
        aria-expanded={open} aria-label={label(name)} title={title} disabled={disabled}
        onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}>
        {name}
        <Icon name="chevron" size={11} className="codex-picker__chevron" />
      </button>
      {open && (
        <AnchoredPopover ref={popover} anchorRef={trigger} align="end" className="codex-scope__popover">
          <strong>Search</strong>
          <small>{note}</small>
          <div className="assistant__scopes" role="group" aria-label="Search scope">
            {SCOPES.map((s) => {
              const reason = unavailable?.[s.value];
              return (
                <button key={s.value} type="button" aria-pressed={scope === s.value} disabled={locked || Boolean(reason)}
                  className={clsx('chip', scope === s.value && 'chip--on')} title={reason ? undefined : s.hint}
                  aria-describedby={reason ? reasonId : undefined}
                  onClick={() => { onChange(s.value); setOpen(false); }}>
                  {s.label}
                </button>
              );
            })}
          </div>
          {reasons.length > 0 && <small id={reasonId} className="codex-scope__reason">{reasons.join(' ')}</small>}
        </AnchoredPopover>
      )}
    </div>
  );
}
