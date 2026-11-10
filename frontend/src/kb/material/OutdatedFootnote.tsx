import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { KbCitation, KbFreshnessMark } from '../../api/kb/types.gen';
import { Popover } from '../ui';
import { useOpenDocument } from '../state/document';
import { useMarksClients } from './marksClients';
import './marks.css';

/**
 * Open question 8 → F5 (decision C0-8): a wiki statement whose cited source has a mark carries a quiet
 * "outdated" next to its source numbers. Hover or keyboard focus shows why — "Retrieval evaluation ·
 * outdated / v3 is out (2026) / Your citation uses v2 · Open material". The join is the page's
 * freshness marks on `material_id` and `block_id`. Marks inside agent answers come after 0.4.0.
 */

const CLOSE_DELAY_MS = 160;

const MarksContext = createContext<readonly KbFreshnessMark[]>([]);

/** The marks of one wiki page; empty (no marker anywhere) while they cannot be read. */
export function PageFreshnessProvider({ pageId, children }: { pageId: string; children: ReactNode }) {
  const { maintenance } = useMarksClients();
  const [marks, setMarks] = useState<readonly KbFreshnessMark[]>([]);
  useEffect(() => {
    let live = true;
    setMarks([]);
    maintenance.page_marks(pageId).then((m) => { if (live) setMarks(m.marks); }, () => undefined);
    return () => { live = false; };
  }, [maintenance, pageId]);
  return <MarksContext.Provider value={marks}>{children}</MarksContext.Provider>;
}

/** The marks that touch this statement through one of its own citations. */
export function marksForBlock(marks: readonly KbFreshnessMark[], pageId: string, blockId: string, citations: readonly KbCitation[]): KbFreshnessMark[] {
  if (marks.length === 0) return [];
  const cited = new Set(citations.map((c) => c.material_id));
  return marks.filter((m) => m.kind !== 'link_gone' && cited.has(m.material_id)
    && m.affected_statements.some((s) => s.page_id === pageId && s.block_id === blockId));
}

const titleOf = (citations: readonly KbCitation[], materialId: string): string =>
  citations.find((c) => c.material_id === materialId)?.material_title ?? 'This source';

function explain(mark: KbFreshnessMark): string | null {
  if (mark.kind === 'new_version' && mark.current_version) return `Your citation uses ${mark.current_version}.`;
  if (mark.kind === 'retracted') return 'The source was retracted.';
  if (mark.kind === 'newer_contradicts') return 'A newer source disagrees with it.';
  return null;
}

function Marker({ mark, title }: { mark: KbFreshnessMark; title: string }) {
  const open = useOpenDocument();
  const ref = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const [state, setState] = useState<'closed' | 'peek' | 'pinned'>('closed');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => cancel, []);
  const peek = () => { cancel(); setState((s) => (s === 'pinned' ? s : 'peek')); };
  const leave = () => { cancel(); timer.current = setTimeout(() => setState((s) => (s === 'peek' ? 'closed' : s)), CLOSE_DELAY_MS); };
  const close = () => { cancel(); setState('closed'); };
  const word = mark.kind === 'retracted' ? 'retracted' : 'outdated';
  const why = explain(mark);
  return (
    <>
      <button ref={ref} type="button" className="kb-outdated__mark" aria-haspopup="dialog" aria-expanded={state !== 'closed'}
        aria-label={`Source ${word}: ${mark.reason}`} onMouseEnter={peek} onMouseLeave={leave} onFocus={peek}
        onBlur={() => { if (state === 'peek') close(); }}
        onKeyDown={(e) => { if (e.key === 'Escape' && state !== 'closed') { e.preventDefault(); e.stopPropagation(); close(); } }}
        onClick={() => { cancel(); setState((s) => (s === 'pinned' ? 'closed' : 'pinned')); }}>
        {word}
      </button>
      <Popover open={state !== 'closed'} onClose={close} anchorRef={ref} label={`Source ${word}`} autoFocus={state === 'pinned'} width={280}>
        <div className="kb-outdatedpop" onMouseEnter={peek} onMouseLeave={() => { if (state === 'peek') leave(); }}>
          <p className="kb-outdatedpop__title" id={titleId}>{`${title} · ${word}`}</p>
          <p>{mark.reason}</p>
          {why && <p className="kb-outdatedpop__note">{why}</p>}
          <button type="button" className="kb-rep__link" onClick={() => { close(); open({ type: 'material', id: mark.material_id }); }}>Open material</button>
        </div>
      </Popover>
    </>
  );
}

/** Beside a statement's source numbers; nothing when no cited source is marked. */
export function OutdatedFootnote({ pageId, blockId, citations }: { pageId: string; blockId: string; citations: readonly KbCitation[] }) {
  const marks = useContext(MarksContext);
  const mine = useMemo(() => marksForBlock(marks, pageId, blockId, citations), [marks, pageId, blockId, citations]);
  if (mine.length === 0) return null;
  return <span className="kb-outdated">{mine.map((m) => <Marker key={m.id} mark={m} title={titleOf(citations, m.material_id)} />)}</span>;
}
