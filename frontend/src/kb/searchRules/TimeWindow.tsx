import { useRef, useState } from 'react';
import type { KbMessagePart } from '../../api/kb/types.gen';
import { useServices } from '../state/context';
import { Icon, Menu, type MenuItem } from '../ui';

/**
 * N7-5 · «what now» questions: the agent states its time window on the answer's first line
 * («Looking at 2024–2026»); SKAZ shows it as a chip whose menu changes the window in one click — the
 * click asks the agent again with the new window (a new question of the user, visible in the chat).
 */

const WINDOW_LINE = /^\s*(?:\*\*|_)?Looking at (\d{4})\s*[–—-]\s*(\d{4})(?:\*\*|_)?\.?[ \t]*(?:\r?\n)*/;

export interface TimeWindow { from: number; to: number }

/** The window line taken out of the answer's first text part (it is shown as the chip instead). */
export function splitWindow(parts: readonly KbMessagePart[]): { window: TimeWindow | null; parts: readonly KbMessagePart[] } {
  const index = parts.findIndex((p) => p.type === 'text');
  const first = index >= 0 ? parts[index] : undefined;
  if (!first || first.type !== 'text') return { window: null, parts };
  const match = WINDOW_LINE.exec(first.text);
  if (!match) return { window: null, parts };
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (!(from >= 1900 && to >= from && to <= 2200)) return { window: null, parts };
  const rest = first.text.slice(match[0].length);
  const next = [...parts];
  if (rest.trim()) next[index] = { ...first, text: rest };
  else next.splice(index, 1);
  return { window: { from, to }, parts: next };
}

/** «Looking at 2024–2026» with a menu of other windows; a choice asks again (a new question). */
export function TimeWindowChip({ window, disabled = false, now = new Date().getFullYear() }: { window: TimeWindow; disabled?: boolean; now?: number }) {
  const { chats } = useServices();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const ask = async (text: string) => {
    setError(null);
    const res = await chats.getState().send({ text, mentions: [], quotes: [], attachments: [] }, {});
    if (!res.ok) setError(res.error);
  };
  const choice = (years: number, label: string): MenuItem => {
    const from = now - years + 1;
    const current = from === window.from && now === window.to;
    return {
      id: `y${years}`, label: `${label} (${from}–${now})`, disabled: current || disabled, note: current ? 'now' : undefined,
      onSelect: () => void ask(`Look at ${from}–${now} instead.`),
    };
  };
  const items: MenuItem[] = [
    choice(1, 'This year and last'), choice(3, 'Last 3 years'), choice(5, 'Last 5 years'), choice(10, 'Last 10 years'),
    { id: 'any', label: 'Any time', disabled, onSelect: () => void ask('Answer without a time window this time.') },
  ];
  return (
    <div className="kb-window">
      <button ref={anchor} type="button" className="kb-window__chip" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Looking at ${window.from}–${window.to}. Change the time window`} onClick={() => setOpen((v) => !v)}>
        <Icon name="clock" size={13} />Looking at {window.from}–{window.to}<Icon name="chevronDown" size={12} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchor} label="Time window" items={items} placement="bottom-start" />
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
    </div>
  );
}

const YEAR = /\b(19\d{2}|20\d{2}|21\d{2})\b/g;

/** The query with its years marked (the year a time-bound search carries is visible on the card). */
export function QueryWithYears({ query }: { query: string }) {
  const out: Array<string | JSX.Element> = [];
  let last = 0;
  for (const match of query.matchAll(YEAR)) {
    out.push(query.slice(last, match.index));
    out.push(<mark key={match.index} className="kb-web__year">{match[0]}</mark>);
    last = (match.index ?? 0) + match[0].length;
  }
  out.push(query.slice(last));
  return <>{out}</>;
}

export const hasYear = (query: string): boolean => /\b(19\d{2}|20\d{2}|21\d{2})\b/.test(query);
