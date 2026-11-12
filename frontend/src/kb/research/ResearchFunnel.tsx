import { useEffect, useState } from 'react';
import type { KbFunnelCandidate } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { Button, Spinner } from '../ui';
import { getResearchStore } from './store';

type Outcome = KbFunnelCandidate['outcome'];
const OUTCOMES: Record<Outcome, string> = {
  dropped_by_rules: 'Dropped by rules', not_fit: 'Does not fit', undecided: 'Undecided',
  covered: 'Already covered', new: 'New', fits: 'Fits · novelty not checked',
};

/** Stored funnel evidence is read on demand. An override is free; Continue is a separate paid click. */
export function ResearchFunnel({ runId, taskId, updatedAt }: { runId: string; taskId: string; updatedAt: string }) {
  const { client } = useServices();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [items, setItems] = useState<KbFunnelCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true); setError(null);
    void client.call('GET /kb/explore/runs/{run_id}/candidates', {
      path: { run_id: runId }, query: { outcome: outcome || undefined, cursor },
    }).then((page) => {
      if (!live) return;
      setItems((previous) => [...new Map([...(cursor ? previous : []), ...page.items].map((item) => [item.candidate_id, item])).values()]);
      setNext(page.next_cursor); setLoading(false);
    }, (e: unknown) => { if (live) { setError(errorText(e)); setLoading(false); } });
    return () => { live = false; };
  }, [client, runId, open, outcome, cursor, retry, updatedAt]);
  const markFits = async (candidate: KbFunnelCandidate) => {
    if (busy) return;
    setBusy(candidate.candidate_id); setError(null);
    try {
      const result = await client.call('POST /kb/explore/runs/{run_id}/candidates/{candidate_id}/fits', {
        path: { run_id: runId, candidate_id: candidate.candidate_id },
      });
      setItems((previous) => previous.map((item) => item.candidate_id === result.candidate_id ? result : item));
      // Refresh the server's checkpoint, never infer a new paid run or resume one on this click.
      await getResearchStore(client).getState().loadTask(taskId);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  };
  return <div className="kb-research-funnel">
    <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      {open ? 'Hide considered works' : 'Show considered works'}
    </Button>
    {open && <section aria-label="Considered works" className="kb-research-funnel__details">
      <label>Show <select aria-label="Candidate outcome" value={outcome} onChange={(e) => {
        setOutcome(e.target.value as Outcome | ''); setCursor(null); setNext(null); setItems([]);
      }}><option value="">All outcomes</option>{Object.entries(OUTCOMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {loading && <Spinner label="Loading considered works" size="sm" />}
      {error && <><p className="kb-inline-error" role="alert">{error}</p><Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button></>}
      {!loading && !error && items.length === 0 && <p>No works in this view yet.</p>}
      <ul className="kb-research-topics__list">{items.map((item) => <li key={item.candidate_id} className="kb-research-funnel__work">
        <strong>{item.work.title}</strong>
        <span>{OUTCOMES[item.outcome]}</span>
        {item.reason && <p>{item.reason}</p>}
        {item.outcome !== 'new' && item.outcome !== 'fits' && <Button size="sm" disabled={busy !== null} busy={busy === item.candidate_id} onClick={() => void markFits(item)}>It fits</Button>}
      </li>)}</ul>
      {items.some((item) => item.overridden && item.outcome === 'fits') && <p className="kb-research-perm__meta">Novelty checks use your model allowance and wait for your Continue.</p>}
      {next && <Button size="sm" disabled={loading} onClick={() => setCursor(next)}>Load more works</Button>}
    </section>}
  </div>;
}
