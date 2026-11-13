import { useEffect, useMemo, useRef, useState } from 'react';
import { createAreasClient } from '../api/areas';
import { createTopicActions } from '../explore/clients';
import { exploreIssue } from '../explore/errors';
import { notifyTopicsChanged } from '../explore/topicEvents';
import { loadTopicOptions, type TopicOption } from '../explore/topicTree';
import { useServices } from '../state/context';
import { Button, Modal, TextField } from '../ui';
import '../explore/explore.css';

export function MoveTopicDialog({ materialId, onClose, onDone }: {
  materialId: string; onClose: () => void; onDone: (topic: { path: string }) => void;
}) {
  const { client } = useServices();
  const areas = useMemo(() => createAreasClient(client), [client]);
  const topics = useMemo(() => createTopicActions(client), [client]);
  const [options, setOptions] = useState<TopicOption[]>([]);
  const [choice, setChoice] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
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
    if (pending.current || (creating ? !name.trim() : !selected)) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (creating) {
        await client.call('POST /kb/materials/{material_id}/new-topic', {
          path: { material_id: materialId }, body: { name: name.trim(), parent_id: parentId || null },
        });
      } else if (selected) await topics.move(materialId, selected.area.id);
      notifyTopicsChanged();
      const parent = options.find((option) => option.area.id === parentId);
      const path = creating ? [parent?.path, name.trim()].filter(Boolean).join(' › ') : selected!.path;
      if (live.current) { onDone({ path }); onClose(); }
    } catch (e) { if (live.current) setError(exploreIssue(e).message); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  return <Modal open title="Move to topic" onClose={close} className="kb-modal--narrow">
    <form className="kb-modal__body" onSubmit={(e) => { e.preventDefault(); void move(); }}>
      {creating ? <>
        <TextField label="Name" autoFocus value={name} maxLength={60} disabled={busy} onChange={(e) => setName(e.target.value)} />
        <label className="kb-topic-destination">Inside
          <select aria-label="Inside" className="kb-explore-select" value={parentId} disabled={busy || loading} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Top level</option>
            {options.filter((option) => option.area.parent_id === null).map((option) => <option key={option.area.id} value={option.area.id}>{option.path}</option>)}
          </select>
        </label>
      </> : <>
      <TextField label="Search topics" value={query} onChange={(e) => setQuery(e.target.value)} />
      <label className="kb-topic-destination">Destination topic
        <select aria-label="Destination topic" className="kb-explore-select" value={choice} disabled={busy || loading} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a topic</option>
          {options.filter((option) => option.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((option) => <option key={option.area.id} value={option.area.id}>{option.path}</option>)}
        </select>
      </label>
      <Button variant="quiet" disabled={busy || loading} onClick={() => { setCreating(true); setError(null); }}>New topic…</Button>
      </>}
      {loading && <p role="status" className="kb-modal__hint">Loading topics…</p>}
      {!loading && !error && options.length === 0 && <p className="kb-modal__hint">Choose New topic… to create a topic with this material.</p>}
      {error && <p role="alert" className="kb-inline-error">{error}{options.length === 0 && <Button variant="quiet" size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}</p>}
      <div className="kb-modal__foot">
        <Button variant="quiet" disabled={busy} onClick={close}>Cancel</Button>
        <Button variant="fill" type="submit" busy={busy} disabled={(creating ? !name.trim() : !choice) || loading}>{creating ? 'Create topic' : 'Move'}</Button>
      </div>
    </form>
  </Modal>;
}
