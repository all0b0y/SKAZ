import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { KbCitation } from '../../api/kb/types.gen';
import { Icon, Popover } from '../ui';
import { clock } from '../ui/time';
import { citationRef, useOpenDocument } from '../state/document';
import { useFragmentText } from './fragments';
import { claimSources, indexSources, type SourceEntry, type SourceIndex } from './sources';

/** The numbering of one answer / one wiki page; marks outside a provider number themselves. */
const SourcesContext = createContext<SourceIndex | null>(null);

export function SourcesProvider({ index, children }: { index: SourceIndex; children: ReactNode }) {
  return <SourcesContext.Provider value={index}>{children}</SourcesContext.Provider>;
}

const CLOSE_DELAY_MS = 160;

function where(c: KbCitation): string | null {
  if (c.start_ms !== null) return clock(c.start_ms);
  if (c.page !== null) return `p. ${c.page}`;
  return null;
}

/**
 * One cited place: page/time, then the exact words as a quote — or, when the answer gave none,
 * the start of the cited fragment (read lazily), labelled "Fragment".
 */
function QuoteItem({ citation: c, onOpen }: { citation: KbCitation; onOpen: (c: KbCitation) => void }) {
  const at = where(c);
  const fragment = useFragmentText(c.material_id, c.seg, !c.quote);
  const action = c.quote ? 'Open at quote' : 'Open at fragment';
  return (
    <div className="kb-srcpop__item">
      {at && (
        <div className="kb-srcpop__meta">
          {c.start_ms !== null && <Icon name="play" size={11} />}
          <span>{at}</span>
        </div>
      )}
      {c.quote ? <blockquote className="kb-srcpop__quote">{c.quote}</blockquote> : (
        <div className="kb-srcpop__frag" aria-busy={fragment.state === 'loading'}>
          <span className="kb-srcpop__fraglabel">Fragment</span>
          {fragment.state === 'ready' && <p className="kb-srcpop__fragtext">{fragment.text}</p>}
          {fragment.state === 'loading' && <p className="kb-srcpop__fragtext is-wait">Reading the fragment…</p>}
          {fragment.state === 'missing' && <p className="kb-srcpop__fragtext is-wait">The fragment’s text couldn’t be read.</p>}
        </div>
      )}
      <button type="button" className="kb-srcpop__open" aria-label={`${action}${at ? `, ${at}` : ''}`} onClick={() => onOpen(c)}>
        {action}<Icon name="chevronRight" size={12} />
      </button>
    </div>
  );
}

function SourcePopup({ entry, quotes, titleId, onOpen }: {
  entry: SourceEntry;
  quotes: KbCitation[];
  titleId: string;
  onOpen: (c: KbCitation) => void;
}) {
  return (
    <div className="kb-srcpop">
      <div className="kb-srcpop__title">
        <Icon name={entry.recording ? 'play' : 'pdf'} size={13} />
        <span id={titleId} title={entry.title}>{entry.title}</span>
      </div>
      {!entry.available ? (
        <p className="kb-srcpop__gone"><Icon name="error" size={12} />This source is no longer available.</p>
      ) : quotes.map((c) => <QuoteItem key={`${c.seg}:${c.quote ?? ''}`} citation={c} onOpen={onOpen} />)}
    </div>
  );
}

/**
 * One source: the trigger (a number mark in the text or an item of the Sources row) and its popup.
 * Hover or keyboard focus shows the popup; a click pins it (focus moves in); Escape or an outside
 * click closes it and focus comes back to the trigger.
 */
function SourceTrigger({ entry, quotes, row = false }: { entry: SourceEntry; quotes: KbCitation[]; row?: boolean }) {
  const open = useOpenDocument();
  const ref = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const [state, setState] = useState<'closed' | 'peek' | 'pinned'>('closed');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Focus coming back to the trigger after a close must not peek the popup open again.
  const quiet = useRef(false);
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => cancel, []);
  const peek = () => { cancel(); setState((s) => (s === 'pinned' ? s : 'peek')); };
  const leave = () => {
    cancel();
    timer.current = setTimeout(() => setState((s) => (s === 'peek' ? 'closed' : s)), CLOSE_DELAY_MS);
  };
  const close = () => {
    cancel();
    quiet.current = true;
    setTimeout(() => { quiet.current = false; }, 0);
    setState('closed');
  };
  const inside = (node: EventTarget | null) => node instanceof Node && !!popRef.current?.parentElement?.contains(node);
  const label = `Source ${entry.n}: ${entry.title}${entry.available ? '' : ' (no longer available)'}`;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`${row ? 'kb-srcs__item' : 'kb-cn'}${entry.available ? '' : ' is-gone'}${state !== 'closed' ? ' is-on' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={state !== 'closed'}
        data-source={entry.n}
        onMouseEnter={peek}
        onMouseLeave={leave}
        onFocus={() => { if (!quiet.current) peek(); }}
        onBlur={(e) => { if (state === 'peek' && !inside(e.relatedTarget)) close(); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && state !== 'closed') { e.preventDefault(); e.stopPropagation(); close(); }
        }}
        onClick={() => { cancel(); setState((s) => (s === 'pinned' ? 'closed' : 'pinned')); }}
      >
        {row ? (
          <>
            <b className="kb-srcs__n">{entry.n}</b>
            <Icon name={entry.recording ? 'play' : 'pdf'} size={12} />
            <span className="kb-srcs__title">{entry.title}</span>
          </>
        ) : entry.n}
      </button>
      <Popover open={state !== 'closed'} onClose={close} anchorRef={ref} label={entry.title}
        autoFocus={state === 'pinned'} className="kb-srcpop-wrap">
        <div
          ref={popRef}
          onMouseEnter={peek}
          onMouseLeave={() => { if (state === 'peek') leave(); }}
          onBlur={(e) => { if (state === 'pinned' && !inside(e.relatedTarget) && e.relatedTarget !== ref.current && e.relatedTarget) close(); }}
        >
          <SourcePopup entry={entry} quotes={quotes} titleId={titleId}
            onOpen={(c) => { close(); open(citationRef(c)); }} />
        </div>
      </Popover>
    </>
  );
}

/** Number marks of one claim: one per source document, duplicates merged. */
export function SourceMarks({ citations }: { citations: ReadonlyArray<KbCitation> }) {
  const outer = useContext(SourcesContext);
  const index = useMemo(() => outer ?? indexSources(citations), [outer, citations]);
  const marks = claimSources(citations, index);
  if (marks.length === 0) return null;
  return (
    <span className="kb-cns">
      {marks.map(({ entry, quotes }) => <SourceTrigger key={entry.key} entry={entry} quotes={quotes} />)}
    </span>
  );
}

/** "Sources 1 [doc] Title …" at the end of an answer or a page. */
export function SourcesRow({ index }: { index: SourceIndex }) {
  if (index.list.length === 0) return null;
  return (
    <div className="kb-srcs" role="group" aria-label="Sources">
      <span className="kb-srcs__head" aria-hidden="true">Sources</span>
      {index.list.map((entry) => <SourceTrigger key={entry.key} entry={entry} quotes={entry.quotes} row />)}
    </div>
  );
}
