import { useEffect, useMemo, useRef, useState } from 'react';
import { createAreasClient } from '../api/areas';
import { createTopicActions } from '../explore/clients';
import { exploreIssue } from '../explore/errors';
import { notifyTopicsChanged } from '../explore/topicEvents';
import { loadTopicOptions, type TopicOption } from '../explore/topicTree';
import { useServices } from '../state/context';
import { Button, Modal } from '../ui';
import '../explore/explore.css';

export function MoveTopicDialog({ materialId, onClose, onDone }: {
  materialId: string; onClose: () => void; onDone: (topic: TopicOption) => void;
}) {
  const { client } = useServices();
  const areas = useMemo(() => createAreasClient(client), [client]);
  const topics = useMemo(() => createTopicActions(client), [client]);
  const [options, setOptions] = useState<TopicOption[]>([]);
  const [choice, setChoice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const pending = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    let active = true; setLoading(true); setError(null);
    void loadTopicOptions(areas).then((items) => { if (active) setOptions(items); })
      .catch((e) => { if (active) setError(exploreIssue(e).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [areas, retry]);
  const close = () => { if (!pending.current) onClose(); };
  const move = async () => {
    const selected = options.find((option) => option.area.id === choice);
    if (!selected || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      await topics.move(materialId, selected.area.id);
      notifyTopicsChanged();
      if (live.current) { onDone(selected); onClose(); }
    } catch (e) { if (live.current) setError(exploreIssue(e).message); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  return <Modal open title="Move to topic" onClose={close} className="kb-modal--narrow">
    <form className="kb-modal__body" onSubmit={(e) => { e.preventDefault(); void move(); }}>
      <label className="kb-topic-destination">Destination topic
        <select aria-label="Destination topic" className="kb-explore-select" value={choice} disabled={busy || loading} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a topic</option>
          {options.map((option) => <option key={option.area.id} value={option.area.id}>{option.path}</option>)}
        </select>
      </label>
      {loading && <p role="status" className="kb-modal__hint">Loading topics…</p>}
      {!loading && !error && options.length === 0 && <p className="kb-modal__hint">Create a topic in Explore first.</p>}
      {error && <p role="alert" className="kb-inline-error">{error}{options.length === 0 && <Button variant="quiet" size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}</p>}
      <div className="kb-modal__foot">
        <Button variant="quiet" disabled={busy} onClick={close}>Cancel</Button>
        <Button variant="fill" type="submit" busy={busy} disabled={!choice || loading}>Move</Button>
      </div>
    </form>
  </Modal>;
}
