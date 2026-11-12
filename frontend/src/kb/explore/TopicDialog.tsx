import { useEffect, useRef, useState } from 'react';
import type { KbArea } from '../../api/kb/types.gen';
import { KbApiError } from '../api/client';
import { Button, Modal, TextField } from '../ui';
import { exploreIssue } from './errors';
import { loadTopicOptions, type TopicOption } from './topicTree';
import type { ExploreClients } from './types';

export type TopicEdit = { mode: 'create' | 'rename' | 'merge'; area: KbArea | null; parentId?: string | null };
export function TopicDialog({ edit, clients, onClose, onSaved }: {
  edit: TopicEdit; clients: ExploreClients; onClose: () => void; onSaved: (area: KbArea, mode: TopicEdit['mode']) => void;
}) {
  const [name, setName] = useState(edit.mode === 'rename' ? edit.area?.name ?? '' : '');
  const [destination, setDestination] = useState('');
  const [options, setOptions] = useState<TopicOption[]>([]);
  const [loading, setLoading] = useState(edit.mode === 'merge');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const pending = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (edit.mode !== 'merge') return;
    let active = true; setLoading(true); setError(null);
    void loadTopicOptions(clients.areas).then((items) => {
      if (active) setOptions(items.filter((item) => item.area.id !== edit.area?.id && !item.ancestors.includes(edit.area!.id)));
    }).catch((e) => { if (active) setError(exploreIssue(e).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [clients.areas, edit.area?.id, edit.mode, retry]);
  const close = () => { if (!pending.current) onClose(); };
  const save = async () => {
    if (pending.current || (edit.mode === 'merge' ? !destination : !name.trim())) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      let area: KbArea;
      if (edit.mode === 'create') area = await clients.areas.create({ name: name.trim(), parent_id: edit.parentId ?? null });
      else if (edit.mode === 'rename') area = await clients.areas.update(edit.area!.id, { name: name.trim() });
      else {
        if (!clients.topics) throw new KbApiError(503, '', 'not_ready');
        area = await clients.topics.merge(edit.area!.id, destination);
      }
      if (!live.current) return;
      onSaved(area, edit.mode); onClose();
    } catch (e) { if (live.current) setError(exploreIssue(e).message); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  const title = edit.mode === 'create' ? edit.parentId ? 'New subtopic' : 'New topic' : edit.mode === 'rename' ? 'Rename topic' : 'Merge topic';
  return <Modal open onClose={close} title={title} className="kb-modal--narrow">
    <form className="kb-modal__body" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {edit.mode === 'merge' ? <>
        <p className="kb-modal__hint">Move the materials and subtopics of “{edit.area?.name}” into another topic.</p>
        <label className="kb-topic-destination">Destination topic
          <select className="kb-explore-select" aria-label="Destination topic" value={destination} disabled={loading || busy} onChange={(e) => setDestination(e.target.value)}>
            <option value="">Choose a topic</option>
            {options.map((option) => <option key={option.area.id} value={option.area.id}>{option.path}</option>)}
          </select>
        </label>
        {loading && <p role="status" className="kb-modal__hint">Loading topics…</p>}
        {!loading && !error && options.length === 0 && <p className="kb-modal__hint">Create another topic before merging.</p>}
      </> : <TextField label="Topic name" value={name} maxLength={200} autoFocus disabled={busy} onChange={(e) => setName(e.target.value)} />}
      {error && <p className="kb-inline-error" role="alert">{error}{edit.mode === 'merge' && !options.length && <button type="button" className="kb-link" onClick={() => setRetry((n) => n + 1)}>Try again</button>}</p>}
      <div className="kb-modal__foot">
        <Button variant="quiet" disabled={busy} onClick={close}>Cancel</Button>
        <Button variant="fill" type="submit" busy={busy} disabled={edit.mode === 'merge' ? !destination || loading : !name.trim()}>{edit.mode === 'create' ? 'Create' : edit.mode === 'rename' ? 'Rename' : 'Merge'}</Button>
      </div>
    </form>
  </Modal>;
}
