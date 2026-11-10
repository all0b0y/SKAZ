import { useRef, useState } from 'react';
import { Icon, Menu, type MenuItem } from '../ui';
import { lastYears, type YearWindow } from './publicationWindow';
import '../material/marks.css';

/**
 * "Looking at 2024–2026" over the library list (N7-5): the same chip and choices as the chat's time
 * window. Without a window it reads "Any time". Dates are publication dates, never the import date.
 */
export function DateFilter({ window, onChange, now = new Date().getFullYear() }: {
  window: YearWindow | null;
  onChange: (window: YearWindow | null) => void;
  now?: number;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const choice = (years: number, label: string): MenuItem => {
    const w = lastYears(years, now);
    const current = window !== null && window.from === w.from && window.to === w.to;
    return { id: `y${years}`, label: `${label} (${w.from}–${w.to})`, disabled: current, note: current ? 'now' : undefined, onSelect: () => onChange(w) };
  };
  const items: MenuItem[] = [
    choice(2, 'This year and last'), choice(3, 'Last 3 years'), choice(5, 'Last 5 years'), choice(10, 'Last 10 years'),
    { id: 'any', label: 'Any time', disabled: window === null, onSelect: () => onChange(null) },
  ];
  const text = window ? `Looking at ${window.from}–${window.to}` : 'Any time';
  return (
    <div className="kb-datefilter">
      <button ref={anchor} type="button" className="kb-window__chip" aria-haspopup="menu" aria-expanded={open}
        aria-label={`${text}. Change the publication window`} onClick={() => setOpen((v) => !v)}>
        <Icon name="clock" size={13} />{text}<Icon name="chevronDown" size={12} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchor} label="Publication window" items={items} placement="bottom-start" />
    </div>
  );
}
