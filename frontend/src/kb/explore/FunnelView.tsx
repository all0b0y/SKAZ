import { useEffect, useRef, useState } from 'react';
import type { KbFunnelCandidate, KbFunnelCandidates, KbFunnelRun } from '../../api/kb/types.gen';
import { KbApiError } from '../api/client';
import { exploreIssue } from './errors';
import type { DiscoveryClient } from './clients';
import './explore.css';

const LABELS: Record<KbFunnelCandidate['outcome'], string> = {
  dropped_by_rules: 'Dropped by your rules', not_fit: 'Does not fit', undecided: 'Undecided', covered: 'Already covered', new: 'New', fits: 'Fits',
};
const dropped = (item: KbFunnelCandidate) => ['dropped_by_rules', 'not_fit', 'undecided', 'covered'].includes(item.outcome);
const append = (first: KbFunnelCandidate[], next: KbFunnelCandidate[]) => {
  const ids = new Set(first.map((item) => item.candidate_id));
  return [...first, ...next.filter((item) => !ids.has(item.candidate_id))];
};

/** The same run funnel can be hosted by Explore or a Research task. No paid work starts on a read or override. */
export function FunnelView({ run, client, busy = false, hidden = false, onCheckNovelty, onChanged }: {
  run: KbFunnelRun; client?: DiscoveryClient; busy?: boolean; hidden?: boolean; onCheckNovelty?: (candidateIds: string[]) => void; onChanged?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<KbFunnelCandidate['outcome'] | ''>('');
  const [snapshot, setSnapshot] = useState<{ key: string; data: KbFunnelCandidates } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const pages = useRef(1);
  const actionPending = useRef(false);
  const writes = useRef(new Map<string, KbFunnelCandidate>());
  const [notice, setNotice] = useState<string | null>(null);
  const key = `${run.id}:${outcome}`;
  const activeKey = useRef(key); activeKey.current = key;
  const data = snapshot?.key === key ? snapshot.data : null;
  const query = outcome ? { outcome } : {};
  useEffect(() => { pages.current = 1; writes.current.clear(); setNotice(null); setPending(null); actionPending.current = false; }, [key]);
  useEffect(() => {
    const generation = ++sequence.current;
    if (!open || hidden) return;
    setError(null); setLoading(true);
    const read = async () => {
      if (!client) throw new KbApiError(503, '', 'not_ready');
      let next = await client.candidates(run.id, outcome ? { outcome } : {});
      const seen = new Set<string>();
      for (let page = 1; page < pages.current && next.next_cursor; page++) {
        const cursor = next.next_cursor;
        if (seen.has(cursor)) throw new Error('Repeated candidates cursor');
        seen.add(cursor);
        const more = await client.candidates(run.id, { ...(outcome ? { outcome } : {}), cursor });
        next = { ...more, items: append(next.items, more.items) };
      }
      if (generation !== sequence.current) return;
      setSnapshot({ key, data: { ...next, items: next.items.map((item) => writes.current.get(item.candidate_id) ?? item) } });
    };
    void read().catch((e) => { if (generation === sequence.current) setError(exploreIssue(e).message); })
      .finally(() => { if (generation === sequence.current) setLoading(false); });
    return () => { sequence.current++; };
  }, [client, key, open, hidden, retry, run.updated_at, run.counters.checked, run.counters.decided, run.counters.novelty_checked]);

  const more = async () => {
    if (!client || !data?.next_cursor || actionPending.current || loading) return;
    const requestKey = key; const generation = ++sequence.current;
    actionPending.current = true; setLoading(true); setError(null);
    try {
      const next = await client.candidates(run.id, { ...query, cursor: data.next_cursor });
      if (activeKey.current !== requestKey || generation !== sequence.current) return;
      if (next.next_cursor === data.next_cursor) throw new Error('Repeated candidates cursor');
      pages.current++;
      setSnapshot({ key, data: { ...next, items: append(data.items, next.items).map((item) => writes.current.get(item.candidate_id) ?? item) } });
    } catch (e) { if (activeKey.current === requestKey) setError(exploreIssue(e).message); }
    finally { if (activeKey.current === requestKey) { actionPending.current = false; setLoading(false); } }
  };
  const fits = async (candidate: KbFunnelCandidate) => {
    if (!client || actionPending.current || busy) return;
    const requestKey = key;
    actionPending.current = true; setPending(candidate.candidate_id); setError(null);
    try {
      const next = await client.fits(run.id, candidate.candidate_id);
      if (activeKey.current !== requestKey) return;
      writes.current.set(next.candidate_id, next);
      setSnapshot((old) => old?.key === key ? { key, data: { ...old.data, items: old.data.items.map((item) => item.candidate_id === next.candidate_id ? next : item) } } : old);
      setNotice('Marked as fitting. Novelty checks wait for your click.');
      await onChanged?.();
    } catch (e) { if (activeKey.current === requestKey) setError(exploreIssue(e).message); }
    finally { if (activeKey.current === requestKey) { actionPending.current = false; setPending(null); } }
  };
  const readyIds = (data?.items ?? []).filter((item) => item.outcome === 'fits' && item.overridden).map((item) => item.candidate_id);
  return <section className="kb-funnel" aria-label="Search funnel">
    <div className="kb-funnel__head">
      <span aria-live="polite">{run.counters.checked} found → {run.counters.on_topic} fit → {run.counters.new} new</span>
      <button type="button" className="kb-explore-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Hide search candidates' : 'Show search candidates'}</button>
    </div>
    {open && <div className="kb-funnel__body">
      {run.plan.length > 0 && <p className="kb-explore-cap">{['running', 'queued', 'paused'].includes(run.state) ? 'Searching' : 'Searched'}: {run.plan.flatMap((item) => item.terms).join(' · ')}</p>}
      <label className="kb-explore-cap">Candidate outcome <select value={outcome} disabled={Boolean(pending)} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
        <option value="">All outcomes</option>
        {Object.entries(LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {error && <p role="alert" className="kb-inline-error">{error}<button type="button" className="kb-link" onClick={() => setRetry((n) => n + 1)}>Try again</button></p>}
      {loading && <p role="status" className="kb-explore-cap">Loading candidates…</p>}
      {!loading && !error && data?.items.length === 0 && <p className="kb-explore-cap">No candidates in this view.</p>}
      {data?.items.map((item) => <article key={item.candidate_id} aria-label={item.work.title} className="kb-funnel__candidate">
        <details><summary>{item.work.title}</summary>
          <p className="kb-explore-cap">{item.work.authors.join(', ')}{item.work.publication.year ? ` · ${item.work.publication.year}` : ''}</p>
          {item.work.abstract && <p>{item.work.abstract}</p>}
        </details>
        <p className="kb-explore-cap">{LABELS[item.outcome]}</p>
        {item.reason && <p className="kb-explore-cap">{item.reason}</p>}
        {dropped(item) && <button type="button" className="kb-explore-btn" disabled={Boolean(pending) || busy || loading} onClick={() => void fits(item)}>{pending === item.candidate_id ? 'Saving…' : 'It fits'}</button>}
      </article>)}
      {data?.next_cursor && <button type="button" className="kb-explore-btn" disabled={loading || Boolean(pending)} onClick={() => void more()}>Load more candidates</button>}
      {notice && <p role="status" className="kb-explore-cap">{notice}</p>}
      {readyIds.length > 0 && onCheckNovelty && <button type="button" className="kb-explore-btn" disabled={busy || Boolean(pending) || loading} onClick={() => onCheckNovelty(readyIds.slice(0, 100))}>{readyIds.length > 100 ? `Check novelty · next 100 of ${readyIds.length}` : 'Check novelty'}</button>}
    </div>}
  </section>;
}
