import { useCallback, useState } from 'react';
import { Button, Icon, Modal } from '../ui';
import { useServices } from '../state/context';

/** One record of `GET /logs` (backend `activity.py`): technical facts only — never text, keys or bodies. */
export interface ActivityEntry {
  sequence: number;
  at_ms: number;
  operation: string;
  provider: string;
  model: string;
  attempt: number;
  elapsed_ms: number;
  outcome: string;
  status: number | null;
  retrying: boolean;
  usage: Partial<Record<'input_tokens' | 'output_tokens' | 'total_tokens', number>>;
}

interface ActivitySnapshot {
  entries: ActivityEntry[];
  capacity: number;
  dropped: number;
}

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const clock = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Entry({ entry }: { entry: ActivityEntry }) {
  const result = entry.status !== null && entry.status !== undefined ? `${entry.outcome} · ${entry.status}` : entry.outcome;
  const tries = entry.attempt > 1 || entry.retrying ? `attempt ${entry.attempt}${entry.retrying ? ', retrying' : ''}` : null;
  const tokens = entry.usage.total_tokens;
  return (
    <li className="kb-activity__item">
      <div className="kb-activity__line">
        <b className="kb-activity__op">{entry.operation}</b>
        <span className="kb-muted kb-activity__at">{clock(entry.at_ms)}</span>
      </div>
      <div className="kb-activity__meta kb-muted">
        <span>{entry.provider} · {entry.model}</span>
        <span className={entry.outcome === 'ok' ? undefined : 'kb-activity__bad'}>{result}</span>
        <span>{seconds(entry.elapsed_ms)}</span>
        {tries && <span>{tries}</span>}
        {tokens !== undefined && <span>{tokens} tokens</span>}
      </div>
    </li>
  );
}

/**
 * Settings → Privacy → Activity log: what ran, when, how long, with what result (`GET /logs`,
 * newest first), read-only. The old interface showed its log in Settings with a button to open the
 * log folder; both are back. Nothing here can carry conversation text or keys — the backend builds
 * every record field by field (backend/tests/test_activity_log_api.py).
 */
export function ActivityLogRow() {
  const { bridge } = useServices();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ data: ActivitySnapshot | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await bridge.request<ActivitySnapshot>({ method: 'GET', path: '/logs', query: { limit: 200 } });
      if (!res.ok) throw new Error(res.detail);
      setState({ data: res.data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ data: s.data, error: error instanceof Error && error.message ? error.message : 'Unknown error', loading: false }));
    }
  }, [bridge]);

  const entries = state.data?.entries ?? [];
  return (
    <>
      <Button size="sm" onClick={() => { setOpen(true); void load(); }}>Show…</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Activity log" className="kb-confirm kb-activity" testId="activity-log">
        <div className="kb-confirm__body kb-activity__body">
          <p className="kb-muted">What SKAZ ran, when, how long it took and how it ended — newest first. Never conversation text, material text or keys. Kept in memory since SKAZ started (the last {state.data?.capacity ?? 256} entries).</p>
          {state.error && (
            <p className="kb-inline-error kb-inline-error--flat" role="alert"><Icon name="error" size={13} />Couldn’t read the activity log: {state.error}</p>
          )}
          {state.data && entries.length === 0 && !state.error && <p className="kb-muted" role="status">Nothing has run yet.</p>}
          {!state.data && state.loading && <p className="kb-muted" role="status">Reading…</p>}
          {entries.length > 0 && (
            <ul className="kb-activity__list" aria-label="Activity, newest first" tabIndex={0}>
              {entries.map((e) => <Entry key={e.sequence} entry={e} />)}
            </ul>
          )}
          {(state.data?.dropped ?? 0) > 0 && <p className="kb-muted">{state.data!.dropped} older entries were dropped.</p>}
        </div>
        <footer className="kb-confirm__foot">
          {bridge.openLogsFolder && (
            <Button icon="folder" variant="quiet" onClick={() => void bridge.openLogsFolder?.()}>Open logs folder</Button>
          )}
          <span className="kb-head__spacer" />
          <Button icon="retry" busy={state.loading} onClick={() => void load()}>Refresh</Button>
          <Button variant="fill" onClick={() => setOpen(false)}>Done</Button>
        </footer>
      </Modal>
    </>
  );
}
