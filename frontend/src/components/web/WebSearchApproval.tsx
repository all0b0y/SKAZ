import { useEffect, useState } from 'react';
import { webSearch, type SearchApproval } from '../../api/webSearch';
import { useCodex } from '../../state/codex';
import './webSearchApproval.css';

/** App-wide, non-modal: navigation cannot hide a waiting background chat. */
export function WebSearchApproval() {
  const running = useCodex((s) => s.tasks.some((t) => t.status === 'running'));
  const chats = useCodex((s) => s.chats);
  const [pending, setPending] = useState<SearchApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!running) { setPending(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await webSearch.pending();
        if (alive) setPending(result.requests[0] ?? null);
      } catch {
        if (alive) { setPending(null); setError('Search approval is unavailable. The request was not allowed.'); }
      }
      if (alive) timer = setTimeout(() => void poll(), 750);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [running]);
  async function decide(approved: boolean) {
    if (!pending || busy) return;
    setBusy(true); setError('');
    try { await webSearch.decide(pending, approved); setPending(null); }
    catch { setError('The approval was not accepted or expired. The search will not be repeated.'); setPending(null); }
    finally { setBusy(false); }
  }
  if (!pending) return running && error ? <div className="web-search-approval" role="status">{error}</div> : null;
  const title = chats.find((c) => c.id === pending.chat_id)?.title ?? pending.chat_id;
  return <section className="web-search-approval" aria-label="Web search approval">
    <strong>Web search · {title}</strong>
    <p>Only this query will be sent to Brave Search. Search API charges may apply.</p>
    <pre>{pending.query}</pre>
    <p>Any new wording needs its own approval. The request waits up to 4 minutes.</p>
    <div className="session-dialog__actions">
      <button className="btn btn--ghost" type="button" disabled={busy} onClick={() => void decide(false)}>Don’t search</button>
      <button className="btn" type="button" disabled={busy} onClick={() => void decide(true)}>Allow this request</button>
    </div>
  </section>;
}
