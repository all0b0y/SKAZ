import { useEffect, useMemo, useRef, useState } from 'react';
import type { KbContinue, KbRepeatCheck } from '../../api/kb/types.gen';
import { createAreasClient } from '../api/areas';
import { createRepeatsClient } from '../api/repeats';
import { CheckProgress } from '../explore/CheckProgress';
import { exploreIssue } from '../explore/errors';
import { loadTopicOptions, type TopicOption } from '../explore/topicTree';
import { useServices } from '../state/context';
import { Button, Modal } from '../ui';
import '../explore/explore.css';

/** Repeat checks are scoped to a topic by the existing N3 API. */
export function OlderMaterials() {
  const { client, ui } = useServices();
  const areas = useMemo(() => createAreasClient(client), [client]);
  const repeats = useMemo(() => createRepeatsClient(client), [client]);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<TopicOption[]>([]);
  const [choice, setChoice] = useState('');
  const [job, setJob] = useState<KbRepeatCheck | null>(null);
  const [poll, setPoll] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadTopicOptions(areas).then((items) => { if (live) setOptions(items); })
      .catch((e) => { if (live) setError(exploreIssue(e).message); });
    return () => { live = false; };
  }, [areas, open]);
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.state) || busy) return;
    let live = true;
    const gen = generation.current;
    const timer = window.setTimeout(() => {
      void repeats.check(job.id).then((next) => { if (live && gen === generation.current) setJob(next); })
        .catch((e) => { if (live) setError(exploreIssue(e).message); })
        .finally(() => { if (live && gen === generation.current) setPoll((n) => n + 1); });
    }, 1000);
    return () => { live = false; window.clearTimeout(timer); };
  }, [job, repeats, busy, poll]);
  const action = async (kind: 'start' | 'pause' | 'resume', decision_choice?: KbContinue['decision_choice']) => {
    if (pending.current) return;
    pending.current = true; generation.current += 1; setBusy(true); setError(null);
    try {
      if (kind === 'start') { setJob(await repeats.start({ area_id: choice })); }
      else if (job && kind === 'pause') setJob(await repeats.pause(job.id));
      else if (job) {
        const latest = await repeats.check(job.id);
        setJob(latest);
        if (latest.state === 'paused' && latest.checkpoint) setJob(await repeats.resume(latest.id, {
          checkpoint_id: latest.checkpoint.id, revision: latest.checkpoint.revision, ...(decision_choice ? { decision_choice } : {}),
        }));
      }
    } catch (e) { setError(exploreIssue(e).message); }
    finally { pending.current = false; setBusy(false); }
  };
  return <>
    <Button size="sm" onClick={() => setOpen(true)}>{job && ['queued', 'running'].includes(job.state) ? 'Checking older materials' : job?.state === 'paused' ? 'Repeat check paused' : 'Check older materials'}</Button>
    {error && !open && <p role="alert" className="kb-inline-error">{error}</p>}
    {open && <Modal open title="Check older materials" onClose={() => { if (!pending.current) setOpen(false); }} className="kb-modal--narrow">
      <form className="kb-modal__body" onSubmit={(e) => { e.preventDefault(); void action('start'); }}>
        {job && <CheckProgress job={job} kind="repeat" busy={busy} onPause={() => void action('pause')}
          onResume={(choice) => void action('resume', choice)} onOpenSettings={() => ui.getState().openSettings('search')} />}
        {job?.state === 'done' && <p role="status">Repeat check complete.</p>}
        {(!job || ['done', 'cancelled', 'error'].includes(job.state)) && <>
        <label>Topic
          <select className="kb-explore-select" aria-label="Topic to check" value={choice} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Choose a topic</option>
            {options.map((option) => <option key={option.area.id} value={option.area.id}>{option.path}</option>)}
          </select>
        </label>
        <p className="kb-modal__hint">Compare older materials in this topic with your wiki. The check pauses at its budget.</p>
        </>}
        {error && <p role="alert" className="kb-inline-error">{error}</p>}
        <div className="kb-modal__foot"><Button variant="quiet" disabled={busy} onClick={() => setOpen(false)}>{job ? 'Close' : 'Cancel'}</Button>
          {(!job || ['done', 'cancelled', 'error'].includes(job.state)) && <Button type="submit" variant="fill" disabled={!choice} busy={busy}>Check</Button>}</div>
      </form>
    </Modal>}
  </>;
}
