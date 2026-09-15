import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Icon } from '../ui/Icon';
import { formatRange } from '../../lib/time';
import type { Citation, Segment, Session } from '../../api/types';

interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Same navigation mechanic App.tsx wires up for AssistantPanel citations. */
  onCite: (citation: Citation) => void;
}

const RESULT_LIMIT = 20;

type Result =
  | { kind: 'session'; session: Session }
  | { kind: 'fragment'; segment: Segment };

/** Splits text into plain/matched runs for a simple case-insensitive highlight. */
function highlightRuns(text: string, query: string): { text: string; match: boolean }[] {
  if (!query.trim()) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const runs: { text: string; match: boolean }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(needle, cursor);
    if (idx === -1) {
      runs.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (idx > cursor) runs.push({ text: text.slice(cursor, idx), match: false });
    runs.push({ text: text.slice(idx, idx + needle.length), match: true });
    cursor = idx + needle.length;
  }
  return runs;
}

export function SearchPalette({ open, onClose, onCite }: SearchPaletteProps) {
  const sessions = useStore((s) => s.sessions);
  const detail = useStore((s) => s.detail);
  const selectSession = useStore((s) => s.selectSession);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Autofocus once the overlay mounts.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const sessionResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
    return matched.slice(0, RESULT_LIMIT);
  }, [sessions, query]);

  const fragmentResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !detail) return [];
    return detail.segments.filter((seg) => seg.text.toLowerCase().includes(q)).slice(0, RESULT_LIMIT);
  }, [detail, query]);

  const results: Result[] = useMemo(
    () => [
      ...sessionResults.map((session): Result => ({ kind: 'session', session })),
      ...fragmentResults.map((segment): Result => ({ kind: 'fragment', segment })),
    ],
    [sessionResults, fragmentResults],
  );

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(results.length - 1, 0)));
  }, [results.length]);

  if (!open) return null;

  const activate = (result: Result) => {
    if (result.kind === 'session') {
      void selectSession(result.session.id);
    } else {
      onCite({
        segment_id: result.segment.id,
        start_ms: result.segment.start_ms,
        end_ms: result.segment.end_ms,
        text: result.segment.text,
      });
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const result = results[activeIndex];
      if (result) activate(result);
    }
  };

  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label="Search materials">
      <button className="palette__scrim" aria-label="Close search" onClick={onClose} />
      <div className="palette__panel">
        <div className="palette__search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search sessions and transcript…"
            aria-label="Search materials"
          />
        </div>

        <div className="palette__results" role="listbox" aria-label="Search results">
          <section className="palette__section">
            <h3 className="palette__section-title">Sessions</h3>
            {sessionResults.length === 0 ? (
              <p className="palette__empty">No matching sessions.</p>
            ) : (
              <ul className="palette__list">
                {sessionResults.map((session, idx) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={results[activeIndex]?.kind === 'session' && results[activeIndex].session.id === session.id}
                      className={clsx(
                        'palette__item',
                        results[activeIndex]?.kind === 'session'
                          && results[activeIndex].session.id === session.id
                          && 'palette__item--active',
                      )}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => activate({ kind: 'session', session })}
                    >
                      <span className="palette__item-title">{session.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="palette__section">
            <h3 className="palette__section-title">Transcript fragments</h3>
            {!query.trim() ? (
              <p className="palette__empty">Type to search the open session's transcript.</p>
            ) : fragmentResults.length === 0 ? (
              <p className="palette__empty">No matches in the open session.</p>
            ) : (
              <ul className="palette__list">
                {fragmentResults.map((segment) => {
                  const globalIdx = sessionResults.length + fragmentResults.indexOf(segment);
                  const active = activeIndex === globalIdx;
                  return (
                    <li key={segment.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={clsx('palette__item', active && 'palette__item--active')}
                        onMouseEnter={() => setActiveIndex(globalIdx)}
                        onClick={() => activate({ kind: 'fragment', segment })}
                      >
                        <span className="palette__item-time tabular">{formatRange(segment.start_ms, segment.end_ms)}</span>
                        <span className="palette__item-text">
                          {highlightRuns(segment.text, query).map((run, i) => (
                            run.match ? <mark key={i}>{run.text}</mark> : <span key={i}>{run.text}</span>
                          ))}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <p className="palette__footnote">Fragments are searched in the open session only.</p>
      </div>
    </div>
  );
}
